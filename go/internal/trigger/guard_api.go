package trigger

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

const (
	apiGuardReasonMax       = 256
	apiGuardDefaultTimeout  = 2 * time.Second
	apiGuardDefaultDenyMsg  = "denied by api guard"
	apiGuardUnreachableFmt  = "api guard unreachable: %s"
	apiGuardMisconfiguredFm = "guard misconfigured: %s"
)

// APIGuard delegates the allow/deny decision to an external HTTP service.
// It fails closed on any transport, parse, or configuration failure.
type APIGuard struct {
	triggerName   string
	url           string
	timeout       time.Duration
	token         string
	httpClient    *http.Client
	misconfigured string
}

type apiGuardRequest struct {
	TriggerName string         `json:"triggerName"`
	TenantId    string         `json:"tenantId"`
	Payload     TriggerPayload `json:"payload"`
}

type apiGuardResponse struct {
	Allow  *bool  `json:"allow"`
	Reason string `json:"reason"`
}

// Check runs the guard against the external API.
func (g *APIGuard) Check(ctx context.Context, tenantId string, payload TriggerPayload) error {
	if g.misconfigured != "" {
		return fmt.Errorf(apiGuardMisconfiguredFm, g.misconfigured)
	}

	reqBody, err := json.Marshal(apiGuardRequest{
		TriggerName: g.triggerName,
		TenantId:    tenantId,
		Payload:     payload,
	})
	if err != nil {
		return fmt.Errorf(apiGuardUnreachableFmt, err)
	}

	callCtx, cancel := context.WithTimeout(ctx, g.timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(callCtx, http.MethodPost, g.url, bytes.NewReader(reqBody))
	if err != nil {
		return fmt.Errorf(apiGuardUnreachableFmt, err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "boilerhouse-trigger-gateway")
	if g.token != "" {
		req.Header.Set("Authorization", "Bearer "+g.token)
	}

	httpClient := g.httpClient
	if httpClient == nil {
		httpClient = http.DefaultClient
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf(apiGuardUnreachableFmt, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf(apiGuardUnreachableFmt, fmt.Sprintf("status %d", resp.StatusCode))
	}

	var parsed apiGuardResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return fmt.Errorf(apiGuardUnreachableFmt, err)
	}
	if parsed.Allow == nil {
		return fmt.Errorf(apiGuardUnreachableFmt, "missing allow field")
	}

	if *parsed.Allow {
		return nil
	}

	reason := strings.TrimSpace(parsed.Reason)
	if reason == "" {
		reason = apiGuardDefaultDenyMsg
	}
	if len(reason) > apiGuardReasonMax {
		reason = reason[:apiGuardReasonMax]
	}
	return fmt.Errorf("%s", reason)
}

// apiGuardSecretRef points at a Kubernetes Secret key holding a bearer token.
type apiGuardSecretRef struct {
	Name string `json:"name"`
	Key  string `json:"key"`
}

// apiGuardConfig is the parsed form of the TriggerGuard.Config JSON for type=api.
type apiGuardConfig struct {
	URL       string             `json:"url"`
	TimeoutMs int                `json:"timeoutMs,omitempty"`
	SecretRef *apiGuardSecretRef `json:"secretRef,omitempty"`
}

// parseAPIGuard builds an APIGuard from a TriggerGuard spec. When the config is
// invalid or a referenced Secret cannot be loaded, the guard is returned in a
// misconfigured state that denies every event.
func parseAPIGuard(ctx context.Context, k8sClient client.Client, namespace, triggerName string, guardSpec v1alpha1.TriggerGuard) *APIGuard {
	g := &APIGuard{
		triggerName: triggerName,
		timeout:     apiGuardDefaultTimeout,
	}

	cfg := apiGuardConfig{}
	if guardSpec.Config != nil && guardSpec.Config.Raw != nil {
		if err := json.Unmarshal(guardSpec.Config.Raw, &cfg); err != nil {
			g.misconfigured = fmt.Sprintf("invalid config: %s", err)
			return g
		}
	}

	if cfg.URL == "" {
		g.misconfigured = "url is required"
		return g
	}
	parsedURL, err := url.Parse(cfg.URL)
	if err != nil || !parsedURL.IsAbs() || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") {
		g.misconfigured = fmt.Sprintf("invalid url %q", cfg.URL)
		return g
	}
	g.url = cfg.URL

	if cfg.TimeoutMs != 0 {
		if cfg.TimeoutMs < 0 {
			g.misconfigured = fmt.Sprintf("timeoutMs must be > 0, got %d", cfg.TimeoutMs)
			return g
		}
		g.timeout = time.Duration(cfg.TimeoutMs) * time.Millisecond
	}

	if cfg.SecretRef != nil {
		if cfg.SecretRef.Name == "" || cfg.SecretRef.Key == "" {
			g.misconfigured = "secretRef requires both name and key"
			return g
		}
		var secret corev1.Secret
		err := k8sClient.Get(ctx, types.NamespacedName{Name: cfg.SecretRef.Name, Namespace: namespace}, &secret)
		if err != nil {
			g.misconfigured = fmt.Sprintf("guard secret unavailable: %s", err)
			return g
		}
		tokenBytes, ok := secret.Data[cfg.SecretRef.Key]
		if !ok {
			g.misconfigured = fmt.Sprintf("guard secret unavailable: key %q not found in secret %q", cfg.SecretRef.Key, cfg.SecretRef.Name)
			return g
		}
		g.token = string(tokenBytes)
	}

	g.httpClient = &http.Client{}
	return g
}
