# `${secret:...}` Credential Injection Syntax — Design Spec

## Goal

Let workload credential headers reference values stored in any Kubernetes Secret. Today the resolver supports `${tenant-secret:NAME}` (reads from `bh-secret-<tenantId>`) and `${global-secret:NAME}` (reads from the operator process's environment variables). The environment-variable mechanism is strictly weaker than a K8s-Secret-backed lookup and has to go — replaced by a new `${secret:[NAMESPACE/]NAME:KEY}` syntax.

This unblocks the kadai preset work (separate spec, follow-up) by giving it a clean way to inject a shared Anthropic API key without either a per-tenant Secret or a patch to the operator Deployment's env vars.

## Scope

- New `${secret:[NAMESPACE/]NAME:KEY}` syntax in credential header values.
- Namespace is optional; defaults to the operator's namespace.
- Delete `${global-secret:NAME}` and its env-var-backed implementation outright. Project is pre-release and no committed YAML uses the old syntax.
- Keep `${tenant-secret:NAME}` unchanged — it has semantically distinct behaviour (tenant-contextual lookup).
- Default operator RBAC stays scoped to its own namespace. Cross-namespace refs require the cluster admin to add a RoleBinding in the target namespace — documented, not automated.
- No resolver-layer caching across reconciles. One K8s `Get` per unique `namespace/name` within a single `ResolveCredentials` call is enough.

## Non-goals

- RBAC automation for cross-namespace lookups. We document the escape hatch; we do not provide a CRD-driven RBAC expansion.
- Rotation / live reload. Values are resolved at pod creation; rotating a referenced Secret does not restart existing pods. Matches current behaviour for `${tenant-secret:...}`.
- Other resolver surface areas (env, command args, mounts). Only credential headers use the syntax today; expanding to other surfaces is out of scope.

## Architecture

Single-file change to `go/internal/operator/sidecar.go`:

```
ResolveCredentials(ctx, client, namespace, tenantId, credentials)
  │
  ├── pre-scan: collect all `${secret:NS/NAME:KEY}` refs                 ← new
  ├── pre-scan: collect all `${tenant-secret:NAME}` refs                 ← unchanged
  ├── fetch tenant Secret once if any ${tenant-secret:...} present      ← unchanged
  ├── fetch each distinct ${secret:...} target once (cache by ns/name)   ← new
  └── for each credential header value:
        resolveValue(val, tenantSecretData, secretLookupCache)
        ├── replace ${tenant-secret:NAME}   → data[NAME]                 ← unchanged
        └── replace ${secret:NS/NAME:KEY}   → cache[NS/NAME].data[KEY]   ← new
```

The `${global-secret:NAME}` regex + `os.Getenv` branch in `resolveValue` are deleted. Package imports no longer need `os` if nothing else uses it (check at edit time).

## Syntax

```
${secret:NAME:KEY}                 # namespace = operator's own
${secret:NAMESPACE/NAME:KEY}       # explicit namespace
```

Regex:

```go
secretRe = regexp.MustCompile(`\$\{secret:(?:([^/}:]+)/)?([^:}]+):([^}]+)\}`)
```

Capture groups:

1. Optional namespace (`NAMESPACE` before the `/`, may be empty)
2. Secret name
3. Key within the Secret's `data` map

Example YAML:

```yaml
credentials:
  - domain: api.anthropic.com
    headers:
      # Same namespace as the operator:
      x-api-key: "${secret:anthropic-api:key}"
      # Explicit cross-namespace:
      x-org-id: "${secret:shared/org-info:org-id}"
```

## Resolver changes

### Implementation sketch

```go
var (
    tenantSecretRe = regexp.MustCompile(`\$\{tenant-secret:([^}]+)\}`)
    secretRe       = regexp.MustCompile(`\$\{secret:(?:([^/}:]+)/)?([^:}]+):([^}]+)\}`)
)

// secretCache keys are "namespace/name". Values are the Secret's data.
type secretCache map[string]map[string][]byte

func fetchAndCache(ctx context.Context, c client.Client, operatorNs string, refs []secretRef, cache secretCache) error {
    for _, r := range refs {
        ns := r.namespace
        if ns == "" {
            ns = operatorNs
        }
        key := ns + "/" + r.name
        if _, ok := cache[key]; ok {
            continue
        }
        var s corev1.Secret
        if err := c.Get(ctx, types.NamespacedName{Name: r.name, Namespace: ns}, &s); err != nil {
            return fmt.Errorf("secret %s: %w", key, err)
        }
        cache[key] = s.Data
    }
    return nil
}
```

`resolveValue` gains the second branch:

```go
result = secretRe.ReplaceAllStringFunc(result, func(match string) string {
    parts := secretRe.FindStringSubmatch(match)
    ns := parts[1]
    if ns == "" {
        ns = operatorNs
    }
    data, ok := cache[ns+"/"+parts[2]]
    if !ok {
        return match // pre-fetch missed; outer caller already errored
    }
    value, ok := data[parts[3]]
    if !ok {
        return match
    }
    return string(value)
})
```

The pre-scan guarantees every referenced Secret is in the cache, so the two `!ok` branches in the replacer only fire when the Secret itself or the key is missing — in which case the pre-scan's `fetchAndCache` would already have returned an error, failing the resolver before this point is reached. For the key-missing-from-present-Secret case, we need an explicit error: add a second pre-check after fetch that every `(ns/name, key)` tuple resolves.

### Errors

- `secret NS/NAME: not found` — Secret doesn't exist.
- `secret NS/NAME: key "KEY" not found` — Secret exists but key missing.
- `secret NS/NAME: forbidden` (or whatever k8s returns) — RBAC denied, most commonly cross-namespace without a RoleBinding.

All three fail the reconcile cycle for the affected pod — same semantics as a missing `${tenant-secret:...}` today.

## RBAC

Default operator RBAC (`config/deploy/operator.yaml`) stays scoped to the operator's own namespace. Cross-namespace references fail until the cluster admin adds a RoleBinding in the target namespace:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: boilerhouse-secret-reader
  namespace: <target-namespace>
rules:
  - apiGroups: [""]
    resources: [secrets]
    verbs: [get]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: boilerhouse-secret-reader
  namespace: <target-namespace>
subjects:
  - kind: ServiceAccount
    name: boilerhouse-operator
    namespace: boilerhouse
roleRef:
  kind: Role
  name: boilerhouse-secret-reader
  apiGroup: rbac.authorization.k8s.io
```

Documented in `docs/` next to the workload credential docs; no code change to operator RBAC.

## Removal of `${global-secret:...}`

Four delete points:

1. `globalSecretRe` regex declaration in `sidecar.go`.
2. The `globalSecretRe.ReplaceAllStringFunc(...)` block in `resolveValue`.
3. `os` import in `sidecar.go` if unused elsewhere.
4. Any tests in `sidecar_test.go` that specifically exercise the env-var-backed path.

Verification before removal:

```bash
grep -r '\${global-secret:' --include='*.yaml' --include='*.yml' --include='*.go' .
# Expected: no matches outside sidecar.go + sidecar_test.go (which we're editing).
```

## Testing

Add to `go/internal/operator/sidecar_test.go`:

- `TestResolveCredentials_SecretSyntax_DefaultNamespace` — `${secret:name:key}` resolves from operator's namespace via the fake client.
- `TestResolveCredentials_SecretSyntax_ExplicitNamespace` — `${secret:other-ns/name:key}` fetches from the specified namespace.
- `TestResolveCredentials_SecretSyntax_MissingSecret` — returns an error containing `"not found"`.
- `TestResolveCredentials_SecretSyntax_MissingKey` — Secret exists, wrong key → error containing `key "…" not found`.
- `TestResolveCredentials_CombinedTenantAndSecret` — one header uses `${tenant-secret:...}` and another uses `${secret:...}` in the same credential block; both resolve correctly.

Delete any existing test that covers `${global-secret:...}` env-var resolution.

## Risks

- **Cross-namespace RBAC opacity.** Users who try `${secret:other-ns/...}` without adding a RoleBinding get a runtime error at pod creation, not a validation-time error. Mitigation: the error message names the specific Secret; docs call it out. A future pass could validate at reconcile start, but that's scope creep.
- **Resolver-time cache staleness.** Secret values are captured at pod creation. Rotating a Secret doesn't restart pods. Same as current behaviour for `${tenant-secret:...}` — consistent, but worth documenting in the same credential docs update.
