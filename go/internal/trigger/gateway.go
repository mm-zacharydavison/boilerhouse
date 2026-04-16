package trigger

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

const (
	syncInterval     = 10 * time.Second
	claimPollTimeout = 120 * time.Second
	claimPollTick    = 1 * time.Second
)

// runningAdapter tracks a running adapter and its cancel function.
type runningAdapter struct {
	adapter Adapter
	cancel  context.CancelFunc
}

// Gateway watches BoilerhouseTrigger CRDs and starts/stops adapters.
type Gateway struct {
	client    client.Client
	namespace string
	adapters  map[string]runningAdapter
	mu        sync.Mutex
	log       *slog.Logger
}

// NewGateway creates a new Gateway.
func NewGateway(k8sClient client.Client, namespace string, log *slog.Logger) *Gateway {
	if log == nil {
		log = slog.Default()
	}
	return &Gateway{
		client:    k8sClient,
		namespace: namespace,
		adapters:  make(map[string]runningAdapter),
		log:       log,
	}
}

// Sync watches BoilerhouseTrigger CRDs and starts/stops adapters. It blocks
// until ctx is cancelled.
func (g *Gateway) Sync(ctx context.Context) error {
	g.log.Info("starting trigger gateway sync loop", "namespace", g.namespace)

	ticker := time.NewTicker(syncInterval)
	defer ticker.Stop()

	// Perform an initial sync immediately.
	if err := g.syncOnce(ctx); err != nil {
		g.log.Error("initial sync failed", "error", err)
	}

	for {
		select {
		case <-ctx.Done():
			g.stopAll()
			return ctx.Err()
		case <-ticker.C:
			if err := g.syncOnce(ctx); err != nil {
				g.log.Error("sync failed", "error", err)
			}
		}
	}
}

// syncOnce lists all triggers and starts/stops adapters as needed.
func (g *Gateway) syncOnce(ctx context.Context) error {
	var triggerList v1alpha1.BoilerhouseTriggerList
	if err := g.client.List(ctx, &triggerList, client.InNamespace(g.namespace)); err != nil {
		return fmt.Errorf("list triggers: %w", err)
	}

	g.mu.Lock()
	defer g.mu.Unlock()

	// Track which triggers are still active.
	activeTriggers := make(map[string]bool)

	for i := range triggerList.Items {
		trigger := &triggerList.Items[i]
		name := trigger.Name

		if trigger.Status.Phase != "Active" {
			continue
		}
		activeTriggers[name] = true

		// If adapter already running, skip.
		if _, ok := g.adapters[name]; ok {
			continue
		}

		// Start a new adapter.
		adapter, err := g.buildAdapter(trigger)
		if err != nil {
			g.log.Error("failed to build adapter", "trigger", name, "error", err)
			continue
		}

		adapterCtx, cancel := context.WithCancel(ctx)
		g.adapters[name] = runningAdapter{adapter: adapter, cancel: cancel}

		handler := g.buildHandler(trigger)
		go func(n string, a Adapter) {
			g.log.Info("starting adapter", "trigger", n, "type", trigger.Spec.Type)
			if err := a.Start(adapterCtx, handler); err != nil {
				g.log.Error("adapter stopped with error", "trigger", n, "error", err)
			}
		}(name, adapter)
	}

	// Stop adapters for triggers that are no longer active.
	for name, ra := range g.adapters {
		if !activeTriggers[name] {
			g.log.Info("stopping adapter", "trigger", name)
			ra.cancel()
			_ = ra.adapter.Stop()
			delete(g.adapters, name)
		}
	}

	return nil
}

// stopAll stops all running adapters.
func (g *Gateway) stopAll() {
	g.mu.Lock()
	defer g.mu.Unlock()

	for name, ra := range g.adapters {
		g.log.Info("stopping adapter", "trigger", name)
		ra.cancel()
		_ = ra.adapter.Stop()
	}
	g.adapters = make(map[string]runningAdapter)
}

// buildAdapter creates the appropriate adapter for a trigger.
func (g *Gateway) buildAdapter(trigger *v1alpha1.BoilerhouseTrigger) (Adapter, error) {
	switch trigger.Spec.Type {
	case "webhook":
		cfg := parseWebhookConfig(trigger)
		return NewWebhookAdapter(cfg.Path, cfg.ListenAddr), nil
	case "cron":
		cfg := parseCronConfig(trigger)
		interval, err := time.ParseDuration(cfg.Interval)
		if err != nil {
			return nil, fmt.Errorf("invalid cron interval %q: %w", cfg.Interval, err)
		}
		return NewCronAdapter(interval, cfg.Payload), nil
	case "telegram":
		cfg := parseTelegramAdapterConfig(trigger)
		return NewTelegramAdapter(cfg), nil
	default:
		return nil, fmt.Errorf("unsupported trigger type: %s", trigger.Spec.Type)
	}
}

// buildHandler creates the EventHandler pipeline for a trigger: resolve tenant,
// run guards, ensure claim, forward to driver.
func (g *Gateway) buildHandler(trigger *v1alpha1.BoilerhouseTrigger) EventHandler {
	guards := g.buildGuards(trigger)
	driver := NewDefaultDriver(nil)

	return func(ctx context.Context, payload TriggerPayload) (any, error) {
		// 1. Resolve tenant ID.
		tenantId, err := ResolveTenantId(trigger.Spec.Tenant, payload)
		if err != nil {
			return nil, fmt.Errorf("resolve tenant: %w", err)
		}

		// 2. Run guard chain.
		for _, guard := range guards {
			if err := guard.Check(ctx, tenantId, payload); err != nil {
				return nil, fmt.Errorf("guard check failed: %w", err)
			}
		}

		// 3. Ensure a BoilerhouseClaim exists and is Active.
		endpoint, err := g.ensureClaim(ctx, tenantId, trigger.Spec.WorkloadRef)
		if err != nil {
			return nil, fmt.Errorf("ensure claim: %w", err)
		}

		// 4. Forward event to instance via driver.
		result, err := driver.Send(ctx, endpoint, payload)
		if err != nil {
			return nil, fmt.Errorf("driver send: %w", err)
		}

		return result, nil
	}
}

// buildGuards constructs guard instances from the trigger spec.
func (g *Gateway) buildGuards(trigger *v1alpha1.BoilerhouseTrigger) []Guard {
	var guards []Guard
	for _, guardSpec := range trigger.Spec.Guards {
		switch guardSpec.Type {
		case "allowlist":
			guard := parseAllowlistGuard(guardSpec)
			guards = append(guards, guard)
		default:
			g.log.Warn("unknown guard type, skipping", "type", guardSpec.Type)
		}
	}
	return guards
}

// ensureClaim creates or finds a BoilerhouseClaim for the given tenant and
// workload, then waits for it to become Active.
func (g *Gateway) ensureClaim(ctx context.Context, tenantId string, workloadRef string) (string, error) {
	claimName := fmt.Sprintf("trigger-%s-%s", workloadRef, tenantId)
	claimKey := types.NamespacedName{Name: claimName, Namespace: g.namespace}

	// Check if claim already exists and is active.
	var existing v1alpha1.BoilerhouseClaim
	err := g.client.Get(ctx, claimKey, &existing)
	if err == nil {
		if existing.Status.Phase == "Active" && existing.Status.Endpoint != nil {
			return formatEndpoint(existing.Status.Endpoint), nil
		}
		// Claim exists but not active yet; fall through to poll.
	} else if !apierrors.IsNotFound(err) {
		return "", fmt.Errorf("get claim: %w", err)
	} else {
		// Create the claim.
		resume := true
		claim := &v1alpha1.BoilerhouseClaim{
			ObjectMeta: metav1.ObjectMeta{
				Name:      claimName,
				Namespace: g.namespace,
			},
			Spec: v1alpha1.BoilerhouseClaimSpec{
				TenantId:    tenantId,
				WorkloadRef: workloadRef,
				Resume:      &resume,
			},
		}
		if err := g.client.Create(ctx, claim); err != nil {
			if !apierrors.IsAlreadyExists(err) {
				return "", fmt.Errorf("create claim: %w", err)
			}
		}
	}

	// Poll until claim is Active.
	return g.waitForClaim(ctx, claimKey)
}

// waitForClaim polls the claim until it is Active or the timeout expires.
func (g *Gateway) waitForClaim(ctx context.Context, key types.NamespacedName) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, claimPollTimeout)
	defer cancel()

	ticker := time.NewTicker(claimPollTick)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return "", fmt.Errorf("timed out waiting for claim %s to become active", key.Name)
		case <-ticker.C:
			var claim v1alpha1.BoilerhouseClaim
			if err := g.client.Get(ctx, key, &claim); err != nil {
				continue
			}
			if claim.Status.Phase == "Active" && claim.Status.Endpoint != nil {
				return formatEndpoint(claim.Status.Endpoint), nil
			}
			if claim.Status.Phase == "Error" {
				return "", fmt.Errorf("claim %s errored: %s", key.Name, claim.Status.Detail)
			}
		}
	}
}

// formatEndpoint builds a URL from a ClaimEndpoint.
func formatEndpoint(ep *v1alpha1.ClaimEndpoint) string {
	if ep.Port > 0 {
		return fmt.Sprintf("http://%s:%d", ep.Host, ep.Port)
	}
	return fmt.Sprintf("http://%s", ep.Host)
}

// --- Config parsing helpers ---

type webhookConfig struct {
	Path       string `json:"path"`
	ListenAddr string `json:"listenAddr"`
}

func parseWebhookConfig(trigger *v1alpha1.BoilerhouseTrigger) webhookConfig {
	cfg := webhookConfig{
		Path:       "/" + trigger.Name,
		ListenAddr: ":8090",
	}
	if trigger.Spec.Config != nil && trigger.Spec.Config.Raw != nil {
		_ = json.Unmarshal(trigger.Spec.Config.Raw, &cfg)
	}
	if cfg.Path == "" {
		cfg.Path = "/" + trigger.Name
	}
	return cfg
}

type cronConfig struct {
	Interval string `json:"interval"`
	Payload  string `json:"payload"`
}

func parseCronConfig(trigger *v1alpha1.BoilerhouseTrigger) cronConfig {
	cfg := cronConfig{
		Interval: "1m",
	}
	if trigger.Spec.Config != nil && trigger.Spec.Config.Raw != nil {
		_ = json.Unmarshal(trigger.Spec.Config.Raw, &cfg)
	}
	return cfg
}

// parseTelegramAdapterConfig extracts the telegram adapter config from a
// trigger's raw config as a generic map.
func parseTelegramAdapterConfig(trigger *v1alpha1.BoilerhouseTrigger) map[string]any {
	cfg := map[string]any{}
	if trigger.Spec.Config != nil && trigger.Spec.Config.Raw != nil {
		_ = json.Unmarshal(trigger.Spec.Config.Raw, &cfg)
	}
	return cfg
}

type allowlistConfig struct {
	TenantIds   []string `json:"tenantIds"`
	DenyMessage string   `json:"denyMessage"`
}

func parseAllowlistGuard(guardSpec v1alpha1.TriggerGuard) *AllowlistGuard {
	cfg := allowlistConfig{}
	if guardSpec.Config != nil && guardSpec.Config.Raw != nil {
		_ = json.Unmarshal(guardSpec.Config.Raw, &cfg)
	}
	return &AllowlistGuard{
		TenantIds:   cfg.TenantIds,
		DenyMessage: cfg.DenyMessage,
	}
}
