# Container-Scoped API Keys (Go/K8s)

## Status: COMPLETE

All items are implemented and merged. See addendum (A1–A6) at the bottom for execution notes.

### Implemented
- **CRD types**: `go/api/v1alpha1/workload_types.go:192-205` — `WorkloadAPIAccess` and `APIAccess` field on spec.
- **Token generation + Secret management**: `go/internal/operator/claim_token.go` — `ensureClaimToken()` (idempotent, 32-byte entropy, TTL annotation, owner refs), `deleteClaimToken()`, `resolveScopes()`, `generateToken()`.
- **Claim controller integration**: `go/internal/operator/claim_pods.go:92` — token provisioned before Pod creation; `claim_release.go:65,178` — token deleted on release and finalizer cleanup.
- **Pod env injection**: `go/internal/operator/translator.go:215-231` — `BOILERHOUSE_API_KEY` and `BOILERHOUSE_API_URL` injected via `SecretKeyRef` when `opts.ClaimTokenSecret` is set.
- **Scope model**: `go/internal/scope/scope.go` — all scope constants and `DefaultAgentScopes`.
- **AuthContext + auth middleware**: `go/internal/api/auth.go:1-129` — `AuthContext`, `HasScope()`, middleware factories.
- **Token store**: `go/internal/api/token_store.go:1-235` — informer-backed cache, hot-path SHA-256 lookup, cold fallback List scan, expiry check.
- **Server integration**: `go/internal/api/server.go:176-212` — `authMiddleware` with admin and scoped paths; trigger routes scoped.
- **API main wiring**: `go/cmd/api/main.go:58-66` — `TokenStore` created and started before server.
- **Test coverage**: `token_store_test.go`, `auth_test.go`, `auth_middleware_test.go`, `claim_token_test.go`.

### Still outstanding (known v1 deferrals)
- Token rotation for Claims exceeding 24h TTL.
- Per-tenant scope overrides (workload-wide only for now).
- Scope checks on existing admin routes (helpers exist; first use is wake-up-tasks).

---

**Goal:** Provision short-lived, scoped API keys for agent containers so they can call the Boilerhouse API with limited permissions. Keys are created when a Claim becomes Active and automatically revoked when the Claim is Released or destroyed. This is the infrastructure layer that wake-up tasks, GitHub Issues skill, and any future agent-facing API access depend on.

The current API (`go/internal/api/server.go:46,161`) accepts a single global `BOILERHOUSE_API_KEY` from env — admin-grade access only. This plan adds a second auth path scoped to a single Claim.

**Design principles:**

1. **K8s-native storage.** No DB. Each token lives in a labelled K8s Secret in the operator namespace. The Secret is the source of truth — provisioning, revocation, and TTL are all standard K8s operations.
2. **Ephemeral.** Tokens live only as long as the Claim. The ClaimReconciler deletes the Secret on `phase=Released` or finalizer cleanup.
3. **Scoped.** Each token is bound to `(tenantId, workloadRef)` and a set of scopes. Routes check both.
4. **Injected automatically.** The Pod gets `BOILERHOUSE_API_KEY` and `BOILERHOUSE_API_URL` via `secretKeyRef` — the agent never requests a key, it just reads env.
5. **No new auth protocol.** Bearer tokens, validated by an extended `authMiddleware`. Admin and scoped keys share the same code path.

---

## Architecture

```
ClaimReconciler observes Claim transitioning to Active
  → if Secret claim-key-{claimName} doesn't exist:
      generate 32-byte random token
      create Secret with labels:
        boilerhouse.io/api-token: "true"
        boilerhouse.io/tenant: <tenantId>
        boilerhouse.io/workload: <workloadRef>
        boilerhouse.io/claim: <claimName>
      annotations: scopes=<csv>, expiresAt=<rfc3339>
      data: token=<32-byte-hex>
  → Patch Pod spec to mount the Secret as env:
      BOILERHOUSE_API_KEY  (from secretKeyRef)
      BOILERHOUSE_API_URL  (literal http://boilerhouse-api.<ns>.svc:3000)

Agent calls API
  → Authorization: Bearer <token>
  → authMiddleware:
      1. if token == s.adminApiKey → AuthContext{Admin}
      2. else look up Secret by token (cached, see below) → AuthContext{Scoped, tenantId, workload, claim, scopes}
  → route handlers call requireScope(ctx, "agent-triggers:write")

ClaimReconciler observes Claim transitioning to Released or being deleted
  → delete Secret claim-key-{claimName}
  → token is invalid on next request (cache TTL bounds staleness)
```

---

## Token Lookup Strategy

Per-request `client.List` on a 5MB Secret-store hot path is unworkable. Use an indexed in-memory cache:

- **Cache type:** `sync.Map` keyed by `tokenHash` (SHA-256 of the bearer token, so plaintext never sits in memory). Value: `AuthContext` + `expiresAt`.
- **Fill strategy:** controller-runtime `cache.Cache` watching Secrets with label selector `boilerhouse.io/api-token=true`. The API server's authenticator subscribes to add/update/delete events and keeps the in-memory map current.
- **Cold lookup miss:** if the token isn't in the cache (cache not warm yet, or out-of-band Secret), fall back to a single labelled-list with the token's hash as a label match. Slow path but correct.
- **Revocation latency:** bounded by informer lag — typically <1s, well under the security tolerance for a delete-and-revoke pattern.

This avoids both the DB and the per-request K8s API call.

---

## Scope Model

```go
// go/internal/api/scopes.go
package api

type Scope string

const (
    ScopeAgentTriggersRead  Scope = "agent-triggers:read"
    ScopeAgentTriggersWrite Scope = "agent-triggers:write"
    ScopeSecretsRead        Scope = "secrets:read"
    ScopeSecretsWrite       Scope = "secrets:write"
    ScopeWorkloadsRead      Scope = "workloads:read"
    ScopeIssuesWrite        Scope = "issues:write"
    ScopeHealthRead         Scope = "health:read"
)

var DefaultAgentScopes = []Scope{
    ScopeAgentTriggersRead,
    ScopeAgentTriggersWrite,
    ScopeSecretsRead,
    ScopeWorkloadsRead,
    ScopeHealthRead,
}
```

Workload definitions can override scopes via a new `apiAccess` field on `BoilerhouseWorkloadSpec`:

```go
// go/api/v1alpha1/workload_types.go (new field)
type WorkloadAPIAccess struct {
    // Scopes overrides the default agent scope set. Set to ["none"] to disable.
    Scopes []string `json:"scopes,omitempty"`
}

type BoilerhouseWorkloadSpec struct {
    // ... existing fields ...
    APIAccess *WorkloadAPIAccess `json:"apiAccess,omitempty"`
}
```

When `APIAccess.Scopes == ["none"]`, no Secret is provisioned and no env vars are mounted.

---

## ClaimReconciler Changes

**File:** `go/internal/operator/claim_controller.go`

### Provisioning

After successful Pod creation in the Active transition (around line 297 where `claim.Status.Phase = "Active"`), call:

```go
if err := r.ensureClaimToken(ctx, &claim, wl); err != nil {
    return reconcile.Result{}, fmt.Errorf("ensure claim token: %w", err)
}
```

Where `ensureClaimToken`:

1. Resolves scopes from `wl.Spec.APIAccess.Scopes` or falls back to `DefaultAgentScopes`. If `["none"]`, return nil.
2. Checks if Secret `claim-key-<claim.Name>` already exists; if so, return.
3. Generates 32 random bytes via `crypto/rand`, hex-encodes.
4. Creates the Secret with the labels/annotations described above and `data["token"] = <hex>`.
5. Sets `OwnerReferences` to the Claim so K8s GC handles cleanup if the Claim disappears unexpectedly.

### Pod Mount

The translator (`translator.go`) already builds the Pod spec from the Workload. To inject the Secret, the ClaimReconciler must patch the Pod after creation OR the translator must accept an extra `claimTokenSecretName` parameter.

**Preferred:** Pass the Secret name into `Translate` via `TranslateOpts` and have it append two env entries to the main container. The Secret is created *before* the Pod (reorder the existing `claim_controller.go` flow so token provisioning precedes Pod creation).

```go
// translator.go — append to container env when ClaimTokenSecret is set
if opts.ClaimTokenSecret != "" {
    env = append(env, corev1.EnvVar{
        Name: "BOILERHOUSE_API_KEY",
        ValueFrom: &corev1.EnvVarSource{
            SecretKeyRef: &corev1.SecretKeySelector{
                LocalObjectReference: corev1.LocalObjectReference{Name: opts.ClaimTokenSecret},
                Key: "token",
            },
        },
    })
    env = append(env, corev1.EnvVar{
        Name: "BOILERHOUSE_API_URL",
        Value: opts.APIServiceURL, // e.g. http://boilerhouse-api.boilerhouse.svc:3000
    })
}
```

### Revocation

In `releaseClaim` (after the Pod is deleted) and in `handleDeletion` (after finalizer cleanup):

```go
secretName := claimTokenSecretName(claim.Name)
err := r.Delete(ctx, &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: secretName, Namespace: claim.Namespace}})
if err != nil && !apierrors.IsNotFound(err) {
    return reconcile.Result{}, fmt.Errorf("deleting claim token secret: %w", err)
}
```

OwnerReferences would handle this automatically on Claim deletion, but explicit deletion makes Released+Resume cycles work cleanly (the next claim gets a fresh token).

### TTL fallback

Even with reliable revocation, set a hard expiry:

- Annotation `boilerhouse.io/expires-at: <rfc3339>` on the Secret (default: 24h after creation).
- The authenticator's cache loader skips entries past expiry.
- A periodic cleanup reconciler (or just a `Watch` with a requeue) deletes expired Secrets.

---

## API Server Changes

**File:** `go/internal/api/server.go`

### `AuthContext`

```go
// go/internal/api/auth.go (new)
package api

import "context"

type AuthKind int
const (
    AuthAdmin AuthKind = iota
    AuthScoped
)

type AuthContext struct {
    Kind     AuthKind
    TenantID string
    Workload string
    ClaimID  string
    Scopes   []Scope
}

type ctxKey int
const authCtxKey ctxKey = 0

func ContextWithAuth(ctx context.Context, ac AuthContext) context.Context {
    return context.WithValue(ctx, authCtxKey, ac)
}
func AuthFromContext(ctx context.Context) (AuthContext, bool) {
    ac, ok := ctx.Value(authCtxKey).(AuthContext)
    return ac, ok
}
```

### `authMiddleware` (modified, was `server.go:161`)

```go
func (s *Server) authMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        token := bearerToken(r)
        if token == "" {
            writeError(w, http.StatusUnauthorized, "missing Authorization header")
            return
        }

        // Admin path.
        if s.apiKey != "" && subtle.ConstantTimeCompare([]byte(token), []byte(s.apiKey)) == 1 {
            ctx := ContextWithAuth(r.Context(), AuthContext{Kind: AuthAdmin})
            next.ServeHTTP(w, r.WithContext(ctx))
            return
        }

        // Scoped path.
        ac, ok := s.tokens.Lookup(token)
        if !ok {
            writeError(w, http.StatusUnauthorized, "invalid API key")
            return
        }
        ctx := ContextWithAuth(r.Context(), ac)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}
```

### Token authenticator

`go/internal/api/token_store.go` — backs `s.tokens`. Owns the informer subscription on Secrets with label `boilerhouse.io/api-token=true`. Exposes `Lookup(token string) (AuthContext, bool)`.

### Scope check helper + tenant isolation

```go
func RequireScope(ctx context.Context, scope Scope) error {
    ac, _ := AuthFromContext(ctx)
    if ac.Kind == AuthAdmin {
        return nil
    }
    for _, s := range ac.Scopes {
        if s == scope {
            return nil
        }
    }
    return fmt.Errorf("missing scope: %s", scope)
}

func RequireOwnTenant(ctx context.Context, tenantId string) error {
    ac, _ := AuthFromContext(ctx)
    if ac.Kind == AuthAdmin {
        return nil
    }
    if ac.TenantID != tenantId {
        return fmt.Errorf("cannot access another tenant's resources")
    }
    return nil
}
```

Routes call these as middleware-style guards. Example for the future agent-triggers route:

```go
if err := RequireScope(r.Context(), ScopeAgentTriggersWrite); err != nil {
    writeError(w, http.StatusForbidden, err.Error())
    return
}
```

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `go/api/v1alpha1/workload_types.go` | Modify | Add `APIAccess *WorkloadAPIAccess` |
| `go/api/v1alpha1/zz_generated.deepcopy.go` | Regenerate | Via `make generate` / kubebuilder |
| `config/crd/bases-go/*workload*.yaml` | Regenerate | Via `make manifests` |
| `go/internal/operator/claim_controller.go` | Modify | `ensureClaimToken`, deletion in release/finalizer paths |
| `go/internal/operator/claim_token.go` | Create | Token generation, Secret naming, scope resolution |
| `go/internal/operator/claim_token_test.go` | Create | Unit + envtest |
| `go/internal/operator/translator.go` | Modify | Mount `BOILERHOUSE_API_KEY` / `BOILERHOUSE_API_URL` env when `TranslateOpts.ClaimTokenSecret` set |
| `go/internal/api/auth.go` | Create | `AuthContext`, scope helpers |
| `go/internal/api/scopes.go` | Create | `Scope` type + constants |
| `go/internal/api/token_store.go` | Create | Informer-backed token authenticator |
| `go/internal/api/token_store_test.go` | Create | Cache hit/miss, label selector, revocation lag |
| `go/internal/api/server.go` | Modify | Wire token store into middleware |
| `go/cmd/api/main.go` | Modify | Construct token store with informer cache |

---

## Sequencing

1. Workload CRD field + regenerate. Pure types.
2. Token generation + Secret naming (`claim_token.go`).
3. `claim_controller.go` provisioning + revocation.
4. Translator env injection.
5. `Scope` constants + `AuthContext` + scope helpers.
6. Token store with informer.
7. Wire into `authMiddleware`.
8. Per-route scope checks (future PRs as routes need them).

Items 1-2 in parallel. Items 3-4 sequential (3 calls into 4). Items 5-6 in parallel with 3-4. Item 7 last.

---

## Security Considerations

- **Entropy:** 32 random bytes via `crypto/rand`. Hex-encoded in the Secret.
- **In-memory hashing:** the in-process cache keys on SHA-256 of the token, not the token itself. Reduces blast radius of a heap dump.
- **Constant-time comparison:** admin path uses `crypto/subtle`. Scoped path goes through map lookup on a hash, which is constant-time enough for this purpose.
- **Revocation latency:** bounded by informer resync (~1s typical). Document this — operators expecting instant revocation should not rely on this for emergency takedown.
- **TTL:** 24h hard cap regardless of Claim lifetime. Long-running Claims need a separate refresh mechanism (out of scope for v1; document as known limitation).
- **Tenant isolation:** enforced at the route layer via `RequireOwnTenant`. Each scoped route MUST call it explicitly — there is no automatic enforcement.
- **Audit:** every authenticated request logs `{tenantId, claim, scope}` via the existing `middleware.Logger`. Scoped requests are easy to filter by presence of `tenantId`.

---

## Open Questions

- **Token rotation:** for Claims that exceed 24h, do we auto-extend on each authenticated request (`lastUsedAt` annotation), or require an explicit refresh endpoint? Lean toward auto-extend; simpler for agents.
- **Scopes per-tenant override:** different tenants of the same workload might need different scopes. Defer — start with workload-wide.
- **K8s ServiceAccount tokens as an alternative:** Projected SA tokens with TokenRequest API would give us K8s-native rotation and audience scoping. Rejected for now because (a) the security plan disabled `automountServiceAccountToken` deliberately, and (b) ServiceAccounts don't carry tenant identity, requiring a parallel mapping anyway. Revisit if/when K8s API access becomes a workload feature.

---

## Addendum: execution adjustments (2026-04-20)

Written after validating the plan against the current codebase. Applies on top of the sections above — nothing is replaced wholesale.

### A1. API server lookup strategy — standalone controller-runtime cache

The plan assumes the API server already has or can trivially subscribe to a controller-runtime cache. Today it doesn't: `go/cmd/api/main.go` builds a plain `client.Client` with no manager and no informers.

**Decision:** instantiate a standalone `sigs.k8s.io/controller-runtime/pkg/cache.Cache` directly in `cmd/api/main.go`, scoped to the operator namespace and with a label selector on `boilerhouse.io/api-token=true`. The `TokenStore` owns this cache, starts it in a goroutine, blocks on `WaitForCacheSync`, and registers an event handler that maintains an in-memory `sha256(token) → AuthContext` map.

No controller-runtime manager is introduced — just the cache + a `client.Client` that reads through it. This matches the operator's idiom without promoting the API to a reconciler.

### A2. Cold-miss fallback — label selector, in-process scan

The original plan proposed "list with the token hash as a label match." A SHA-256 hex digest is 64 chars and exceeds the 63-char k8s label value limit, so this fallback won't compile. Replace with:

1. `List` Secrets with selector `boilerhouse.io/api-token=true` in the operator namespace (set is small — one per active Claim).
2. Recompute `sha256` in-process over each Secret's `data["token"]` and match.
3. On hit, cache the entry; on miss, reject.

Cold misses should be rare in steady state (the watch handler fills the cache eagerly), so the cost of the scan is acceptable.

### A3. CRD regeneration — controller-gen, not make

There is no `Makefile` in the repo. The setup script installs `controller-gen`. The concrete commands to regenerate after touching `go/api/v1alpha1/`:

```sh
cd go
controller-gen object paths=./api/...
controller-gen crd paths=./api/... output:crd:dir=../config/crd/bases-go
```

Ship these as a new kadai action `codegen` so future CRD edits have a single entry point.

### A4. Line-number drift in the plan

The line numbers embedded in the plan were written against an older tree. The real anchors at the time of execution:

| Plan reference | Actual location |
|---|---|
| `server.go:46,161` (authMiddleware) | `server.go:159` |
| `claim_controller.go:297` (`Phase = "Active"`) | `claim_controller.go:339` inside `activateClaim` |
| `releaseClaim` / `handleDeletion` hook points | `releaseClaim` at ~line 442, `handleDeletion` at ~line 533 |

Follow the *shape* of the plan; verify the anchor in-code before editing.

### A5. In-cluster API URL

Confirmed against `config/deploy/api.yaml`: service name `boilerhouse-api`, namespace `boilerhouse`, port 3000. `BOILERHOUSE_API_URL` defaults to `http://boilerhouse-api.boilerhouse.svc:3000` and is overridable via operator env (for dev against a forwarded port).

### A6. Not in v1

Locked for this PR:
- No token rotation / refresh endpoint — 24h hard TTL documented, no auto-extend.
- No retrofitting scope checks onto existing admin-only routes. Helpers ship; first route to use them is wake-up-tasks (feat #6).
- No per-tenant scope override. Workload-wide only.
