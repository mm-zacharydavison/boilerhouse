package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	v1alpha1 "github.com/zdavison/boilerhouse/go/api/v1alpha1"
	"github.com/zdavison/boilerhouse/go/internal/claimtoken"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// agentTriggerRequest is the JSON body for POST /api/v1/agent-triggers. Agents
// describe what they want fired ("remind me at 3pm with this task"); the
// handler resolves workloadRef, tenant, and reply channel from the caller's
// AuthContext and originating Claim. Bot tokens are never accepted from the
// body — they are inherited from the originating trigger.
type agentTriggerRequest struct {
	Type     string         `json:"type"` // "cron" | "one-shot"
	Schedule string         `json:"schedule,omitempty"`
	RunAt    string         `json:"runAt,omitempty"`
	Payload  map[string]any `json:"payload,omitempty"`
	Label    string         `json:"label"`
}

type agentTriggerResponse struct {
	Name      string `json:"name"`
	Type      string `json:"type"`
	Schedule  string `json:"schedule,omitempty"`
	RunAt     string `json:"runAt,omitempty"`
	Label     string `json:"label"`
	CreatedAt string `json:"createdAt"`
	Phase     string `json:"phase"`
}

// agentTriggerPolicy returns the server's configured policy or the default if
// none was set.
func (s *Server) agentTriggerPolicy() AgentTriggerPolicy {
	if len(s.agentPolicy.AllowedTypes) == 0 {
		return DefaultAgentTriggerPolicy
	}
	return s.agentPolicy
}

func (s *Server) createAgentTrigger(w http.ResponseWriter, r *http.Request) {
	ac, ok := AuthFromContext(r.Context())
	if !ok || ac.Kind != AuthScoped {
		writeError(w, http.StatusForbidden, "agent-triggers require a scoped token")
		return
	}

	var req agentTriggerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if req.Label == "" {
		writeError(w, http.StatusBadRequest, "label is required")
		return
	}

	policy := s.agentTriggerPolicy()
	if !policy.allowsType(req.Type) {
		writeError(w, http.StatusBadRequest, "type not allowed for agent triggers")
		return
	}

	now := time.Now().UTC()

	// Per-type validation. Builds the spec.config map that the trigger
	// gateway parses (cron expects `interval`; one-shot expects `runAt`).
	configMap := map[string]any{}
	switch req.Type {
	case "cron":
		if req.Schedule == "" {
			writeError(w, http.StatusBadRequest, "schedule is required for cron triggers")
			return
		}
		interval, err := time.ParseDuration(req.Schedule)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid schedule duration: "+err.Error())
			return
		}
		if interval < policy.MinCronInterval {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("schedule must be >= %s", policy.MinCronInterval))
			return
		}
		// CronAdapter takes the payload as a string; encode the agent's
		// structured payload as JSON so the workload sees the full object.
		payloadStr := ""
		if req.Payload != nil {
			b, _ := json.Marshal(req.Payload)
			payloadStr = string(b)
		}
		configMap["interval"] = req.Schedule
		configMap["payload"] = payloadStr
	case "one-shot":
		if req.RunAt == "" {
			writeError(w, http.StatusBadRequest, "runAt is required for one-shot triggers")
			return
		}
		runAt, err := time.Parse(time.RFC3339, req.RunAt)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid runAt: "+err.Error())
			return
		}
		delta := runAt.Sub(now)
		if delta < policy.MinOneShotDelay {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("runAt must be at least %s in the future", policy.MinOneShotDelay))
			return
		}
		if delta > policy.MaxOneShotHorizon {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("runAt must be within %s from now", policy.MaxOneShotHorizon))
			return
		}
		configMap["runAt"] = runAt.UTC().Format(time.RFC3339)
		if req.Payload != nil {
			configMap["payload"] = req.Payload
		}
	default:
		writeError(w, http.StatusBadRequest, "type not allowed for agent triggers")
		return
	}

	// Quota: count existing live agent triggers for this tenant.
	count, err := s.countAgentTriggers(r.Context(), ac.TenantID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "count existing agent triggers: "+err.Error())
		return
	}
	if count >= policy.MaxTriggersPerTenant {
		writeError(w, http.StatusForbidden, fmt.Sprintf("agent trigger quota exceeded (%d)", policy.MaxTriggersPerTenant))
		return
	}

	// Resolve replyContext from the originating trigger pointed to by the
	// Claim's annotation. Agents never supply bot tokens.
	if ac.ClaimID == "" {
		writeError(w, http.StatusForbidden, "scoped token is missing claim binding")
		return
	}
	replyCtx, err := s.resolveReplyContextForClaim(r.Context(), ac.ClaimID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "resolve reply context: "+err.Error())
		return
	}
	if replyCtx != nil {
		configMap["replyContext"] = replyCtx
	}

	rawCfg, err := json.Marshal(configMap)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "marshal config: "+err.Error())
		return
	}

	name, err := generateAgentTriggerName(ac.TenantID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "generate name: "+err.Error())
		return
	}

	trigger := &v1alpha1.BoilerhouseTrigger{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: s.namespace,
			Labels: map[string]string{
				claimtoken.LabelOrigin:          claimtoken.OriginAgent,
				claimtoken.LabelCreatedByTenant: ac.TenantID,
				claimtoken.LabelTenant:          ac.TenantID,
				claimtoken.LabelWorkload:        ac.Workload,
			},
			Annotations: map[string]string{
				"boilerhouse.dev/label": req.Label,
			},
		},
		Spec: v1alpha1.BoilerhouseTriggerSpec{
			Type:        req.Type,
			WorkloadRef: ac.Workload,
			Tenant:      &v1alpha1.TriggerTenant{Static: ac.TenantID},
			Config:      &runtime.RawExtension{Raw: rawCfg},
		},
	}

	if err := s.client.Create(r.Context(), trigger); err != nil {
		writeError(w, http.StatusInternalServerError, "create trigger: "+err.Error())
		return
	}

	// Phase=Active so the gateway picks it up on next sync. Status is a
	// subresource; set it after Create.
	trigger.Status.Phase = "Active"
	if err := s.client.Status().Update(r.Context(), trigger); err != nil {
		// Best-effort cleanup so a half-created trigger doesn't linger.
		_ = s.client.Delete(r.Context(), trigger)
		writeError(w, http.StatusInternalServerError, "set trigger phase: "+err.Error())
		return
	}

	writeJSON(w, http.StatusCreated, agentTriggerToResponse(trigger))
}

func (s *Server) listAgentTriggers(w http.ResponseWriter, r *http.Request) {
	ac, ok := AuthFromContext(r.Context())
	if !ok || ac.Kind != AuthScoped {
		writeError(w, http.StatusForbidden, "agent-triggers require a scoped token")
		return
	}

	var list v1alpha1.BoilerhouseTriggerList
	err := s.client.List(r.Context(), &list,
		client.InNamespace(s.namespace),
		client.MatchingLabels{
			claimtoken.LabelOrigin:          claimtoken.OriginAgent,
			claimtoken.LabelCreatedByTenant: ac.TenantID,
		},
	)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list agent triggers: "+err.Error())
		return
	}

	items := make([]agentTriggerResponse, 0, len(list.Items))
	for i := range list.Items {
		items = append(items, agentTriggerToResponse(&list.Items[i]))
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) deleteAgentTrigger(w http.ResponseWriter, r *http.Request) {
	ac, ok := AuthFromContext(r.Context())
	if !ok || ac.Kind != AuthScoped {
		writeError(w, http.StatusForbidden, "agent-triggers require a scoped token")
		return
	}

	name := chi.URLParam(r, "name")
	var existing v1alpha1.BoilerhouseTrigger
	err := s.client.Get(r.Context(), types.NamespacedName{Name: name, Namespace: s.namespace}, &existing)
	if err != nil {
		if apierrors.IsNotFound(err) {
			writeError(w, http.StatusNotFound, "trigger not found")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Tenant isolation — 404 (not 403) on miss to avoid leaking existence.
	if existing.Labels[claimtoken.LabelOrigin] != claimtoken.OriginAgent ||
		existing.Labels[claimtoken.LabelCreatedByTenant] != ac.TenantID {
		writeError(w, http.StatusNotFound, "trigger not found")
		return
	}

	if err := s.client.Delete(r.Context(), &existing); err != nil {
		writeError(w, http.StatusInternalServerError, "delete trigger: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// countAgentTriggers returns the number of live BoilerhouseTriggers labelled
// origin=agent for the given tenant.
func (s *Server) countAgentTriggers(ctx context.Context, tenantID string) (int, error) {
	var list v1alpha1.BoilerhouseTriggerList
	err := s.client.List(ctx, &list,
		client.InNamespace(s.namespace),
		client.MatchingLabels{
			claimtoken.LabelOrigin:          claimtoken.OriginAgent,
			claimtoken.LabelCreatedByTenant: tenantID,
		},
	)
	if err != nil {
		return 0, err
	}
	return len(list.Items), nil
}

// resolveReplyContextForClaim reads the originating-trigger annotation off
// the named Claim, fetches that admin trigger, and copies its bot token /
// reply config into a ReplyContext-shaped map. Returns nil (no error) when
// no originating trigger is recorded — agent triggers can still fire, just
// without an outbound reply channel.
//
// The returned value is a map[string]any so the trigger gateway's existing
// JSON-based config parsing can deserialize it into a trigger.ReplyContext
// without forcing the api package to import the trigger package.
func (s *Server) resolveReplyContextForClaim(ctx context.Context, claimName string) (map[string]any, error) {
	var claim v1alpha1.BoilerhouseClaim
	err := s.client.Get(ctx, types.NamespacedName{Name: claimName, Namespace: s.namespace}, &claim)
	if err != nil {
		if apierrors.IsNotFound(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("get claim %s: %w", claimName, err)
	}
	originating := claim.Annotations[claimtoken.AnnotationOriginatingTrigger]
	if originating == "" {
		return nil, nil
	}

	var origin v1alpha1.BoilerhouseTrigger
	err = s.client.Get(ctx, types.NamespacedName{Name: originating, Namespace: s.namespace}, &origin)
	if err != nil {
		if apierrors.IsNotFound(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("get originating trigger %s: %w", originating, err)
	}

	switch origin.Spec.Type {
	case "telegram":
		return s.replyContextFromTelegramTrigger(ctx, &origin)
	default:
		// Unsupported reply transport — agent trigger fires without a
		// reply channel. Not an error.
		return nil, nil
	}
}

// readSecretValue fetches a single key from a Secret in the server's
// namespace, returning the value as a string.
func (s *Server) readSecretValue(ctx context.Context, name, key string) (string, error) {
	var sec corev1.Secret
	if err := s.client.Get(ctx, types.NamespacedName{Name: name, Namespace: s.namespace}, &sec); err != nil {
		return "", err
	}
	v, ok := sec.Data[key]
	if !ok {
		return "", fmt.Errorf("secret %s missing key %s", name, key)
	}
	return string(v), nil
}

// replyContextFromTelegramTrigger extracts the bot token + chatId from a
// telegram trigger's spec.config (resolving secretRef if needed) into the
// ReplyContext map shape consumed by trigger.SendReply.
func (s *Server) replyContextFromTelegramTrigger(ctx context.Context, t *v1alpha1.BoilerhouseTrigger) (map[string]any, error) {
	if t.Spec.Config == nil || t.Spec.Config.Raw == nil {
		return nil, nil
	}
	var raw map[string]any
	if err := json.Unmarshal(t.Spec.Config.Raw, &raw); err != nil {
		return nil, nil
	}

	rc := map[string]any{"adapter": "telegram"}
	if v, ok := raw["botToken"].(string); ok && v != "" {
		rc["botToken"] = v
	} else if ref, ok := raw["botTokenSecretRef"].(map[string]any); ok {
		name, _ := ref["name"].(string)
		key, _ := ref["key"].(string)
		if name != "" && key != "" {
			tok, err := s.readSecretValue(ctx, name, key)
			if err != nil {
				return nil, fmt.Errorf("read bot token secret: %w", err)
			}
			rc["botToken"] = tok
		}
	}
	if v, ok := raw["apiBaseURL"].(string); ok && v != "" {
		rc["apiBaseUrl"] = v
	}
	if v, ok := raw["chatId"].(float64); ok {
		rc["chatId"] = int64(v)
	}
	if _, hasToken := rc["botToken"]; !hasToken {
		// Without a token we can't reply — return nil so the trigger
		// fires but doesn't try to send a Telegram message.
		return nil, nil
	}
	return rc, nil
}

func agentTriggerToResponse(t *v1alpha1.BoilerhouseTrigger) agentTriggerResponse {
	resp := agentTriggerResponse{
		Name:      t.Name,
		Type:      t.Spec.Type,
		Label:     t.Annotations["boilerhouse.dev/label"],
		CreatedAt: t.CreationTimestamp.UTC().Format(time.RFC3339),
		Phase:     t.Status.Phase,
	}
	if t.Spec.Config != nil && t.Spec.Config.Raw != nil {
		var cfg map[string]any
		if err := json.Unmarshal(t.Spec.Config.Raw, &cfg); err == nil {
			if v, ok := cfg["interval"].(string); ok {
				resp.Schedule = v
			}
			if v, ok := cfg["runAt"].(string); ok {
				resp.RunAt = v
			}
		}
	}
	return resp
}

// generateAgentTriggerName builds a stable-format CR name "agent-<tenant>-<8hex>".
// The tenant component is sanitized to be DNS-label-safe (a-z, 0-9, '-').
func generateAgentTriggerName(tenantID string) (string, error) {
	var buf [4]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return fmt.Sprintf("agent-%s-%s", sanitizeDNSLabel(tenantID), hex.EncodeToString(buf[:])), nil
}

// sanitizeDNSLabel lowercases the input and replaces any character outside
// [a-z0-9-] with '-'. Empty result becomes "x".
func sanitizeDNSLabel(s string) string {
	s = strings.ToLower(s)
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	out := b.String()
	if out == "" {
		return "x"
	}
	// DNS labels must be <= 63 chars; agent name has a 14-char overhead
	// ("agent-" + "-" + 8 hex), so cap tenant chunk at 40 to stay safe.
	if len(out) > 40 {
		out = out[:40]
	}
	return out
}
