# K8s-Native Credential Injection Schema — Design Spec

## Goal

Replace the string-template credential-injection mechanism (`${tenant-secret:NAME}`, `${global-secret:NAME}`) on `BoilerhouseWorkload.network.credentials[].headers` with a canonical Kubernetes-style structured schema. Header values become a tagged union of `value` (literal) or `valueFrom.secretKeyRef` (K8s Secret reference). No string parsing, no regex, schema-validated at `kubectl apply` time.

Tenant-scoped secrets are deferred — this spec supports only global Secrets in the operator's namespace. A follow-up spec will re-introduce a typed `tenantSecretKeyRef` for tenant-contextual resolution.

## Scope

- New CRD types `HeaderEntry`, `HeaderValueSource`, reusing the existing-but-unused `SecretKeyRef`.
- `NetworkCredential.Headers` changes from `*runtime.RawExtension` (map-of-strings) to `[]HeaderEntry`.
- New structural resolver in `go/internal/operator/sidecar.go`.
- All three string-template syntaxes deleted (`${tenant-secret:...}`, `${global-secret:...}`, and the never-shipped `${secret:...}`).
- Per-tenant Secret management surface deleted: `routes_secret.go`, `secretName()` helper, `bh-secret-` naming convention, and the tenant-secret tests.
- Migration of the two workload YAMLs (`workloads/claude-code.yaml`, `workloads/openclaw.yaml`) to the new schema.
- Dashboard code that called the deleted REST endpoints is removed in the same change.

## Non-goals

- Tenant-scoped secret resolution. Returning as `tenantSecretKeyRef` in a later spec.
- Cross-namespace Secret references. All referenced Secrets live in the operator's namespace.
- `headersFrom`-style bulk-import (analogous to K8s `envFrom.secretRef`). Per-entry refs are enough for current workloads.
- Admission-webhook-level validation. Exactly-one-of validation happens at reconcile time; a webhook is a future hardening.
- CRD versioning / conversion. Pre-release; the breaking schema change ships straight on `v1alpha1`.

## Architecture

Three existing pieces interact; the change rewrites the middle one and deletes the left one's tenant-secret branch.

```
BoilerhouseWorkload CR                  ResolveCredentials (sidecar.go)               Envoy sidecar config
  network.credentials[]                    │                                           │
    headers: []HeaderEntry     ─────────►  │  for each header:                         │
      - name, value                        │    - literal  → use as-is                 │
      - name, valueFrom.secretKeyRef       │    - ref      → K8s Get (cached per call) │
                                           │                                           │
                                           └──► []envoy.ResolvedCredential ───────────►│
                                                 (domain, map[name]value)              │
```

All Secret lookups use the k8s client the operator already has. Cache is per-call (`map[secretName]data`) so one Secret referenced by many headers is fetched once. Errors identify both the credential's domain and the header's name.

## CRD types

`go/api/v1alpha1/workload_types.go`:

```go
// NetworkCredential configures credential injection for a target domain.
type NetworkCredential struct {
    // Domain is the target domain the Envoy sidecar injects these headers for.
    Domain string `json:"domain,omitempty"`

    // Headers to inject on requests to Domain.
    // +optional
    Headers []HeaderEntry `json:"headers,omitempty"`
}

// HeaderEntry is one injected header. Exactly one of Value or ValueFrom must be set.
type HeaderEntry struct {
    // Name is the HTTP header name.
    Name string `json:"name"`

    // Value is a literal header value.
    // +optional
    Value string `json:"value,omitempty"`

    // ValueFrom sources the value from a Kubernetes Secret in the operator's
    // namespace.
    // +optional
    ValueFrom *HeaderValueSource `json:"valueFrom,omitempty"`
}

// HeaderValueSource describes how a header value is sourced.
type HeaderValueSource struct {
    // SecretKeyRef selects a key from a Secret in the operator's namespace.
    SecretKeyRef *SecretKeyRef `json:"secretKeyRef"`
}

// SecretKeyRef references a single key within a Kubernetes Secret.
type SecretKeyRef struct {
    // Name is the name of the Secret in the operator's namespace.
    Name string `json:"name"`
    // Key is the key within the Secret's data map.
    Key string `json:"key"`
}
```

**Deletions from this file:**

- `NetworkCredential.SecretRef *SecretKeyRef` — dead credential-level field, never read.
- The previous `Headers *runtime.RawExtension` declaration.
- The `+kubebuilder:pruning:PreserveUnknownFields` annotation on Headers.

**Validation.** Exactly-one-of (`value` XOR `valueFrom`) is enforced at reconcile time in the operator's workload controller — kubebuilder's OpenAPI generator does not emit tagged-union `oneOf` cleanly. On violation, the Workload transitions to `Status.Phase = Error` with a readable message identifying the offending credential + header. An admission webhook could tighten this later but is out of scope.

**CRD regeneration.** `config/crd/bases-go/boilerhouse.dev_boilerhouseworkloads.yaml` is regenerated from the Go types via the existing `controller-gen` pipeline. Both the Go type change and the regenerated CRD YAML ship in the same commit.

## Resolver

`go/internal/operator/sidecar.go` — replace the current `ResolveCredentials` + `resolveValue` + regex blocks with:

```go
// ResolveCredentials resolves Secret references in workload credential headers.
// All secretKeyRefs resolve from Secrets in the operator's namespace.
func ResolveCredentials(ctx context.Context, k8sClient client.Client, namespace string, credentials []v1alpha1.NetworkCredential) ([]envoy.ResolvedCredential, error) {
    secretCache := map[string]map[string][]byte{}

    var resolved []envoy.ResolvedCredential
    for _, cred := range credentials {
        if cred.Domain == "" {
            continue
        }

        headers := make(map[string]string, len(cred.Headers))
        for _, h := range cred.Headers {
            if h.Name == "" {
                return nil, fmt.Errorf("credential for domain %s: header entry missing name", cred.Domain)
            }

            switch {
            case h.ValueFrom == nil && h.Value == "":
                return nil, fmt.Errorf("credential for domain %s: header %q has neither value nor valueFrom", cred.Domain, h.Name)
            case h.ValueFrom != nil && h.Value != "":
                return nil, fmt.Errorf("credential for domain %s: header %q sets both value and valueFrom", cred.Domain, h.Name)
            case h.ValueFrom != nil:
                v, err := resolveSecretKeyRef(ctx, k8sClient, namespace, h.ValueFrom.SecretKeyRef, secretCache)
                if err != nil {
                    return nil, fmt.Errorf("credential for domain %s, header %q: %w", cred.Domain, h.Name, err)
                }
                headers[h.Name] = v
            default:
                headers[h.Name] = h.Value
            }
        }

        resolved = append(resolved, envoy.ResolvedCredential{Domain: cred.Domain, Headers: headers})
    }

    return resolved, nil
}

// resolveSecretKeyRef fetches (and caches) a Secret in the operator namespace
// and returns the value at ref.Key.
func resolveSecretKeyRef(ctx context.Context, k8sClient client.Client, namespace string, ref *v1alpha1.SecretKeyRef, cache map[string]map[string][]byte) (string, error) {
    if ref == nil {
        return "", fmt.Errorf("valueFrom.secretKeyRef is nil")
    }
    if ref.Name == "" || ref.Key == "" {
        return "", fmt.Errorf("secretKeyRef requires name and key")
    }

    data, ok := cache[ref.Name]
    if !ok {
        var secret corev1.Secret
        if err := k8sClient.Get(ctx, types.NamespacedName{Name: ref.Name, Namespace: namespace}, &secret); err != nil {
            return "", fmt.Errorf("secret %q: %w", ref.Name, err)
        }
        data = secret.Data
        cache[ref.Name] = data
    }

    value, ok := data[ref.Key]
    if !ok {
        return "", fmt.Errorf("secret %q: key %q not found", ref.Name, ref.Key)
    }
    return string(value), nil
}
```

**Deletions from `sidecar.go`:**

- `globalSecretRe`, `tenantSecretRe` regexes.
- `resolveValue(...)` function.
- The tenant-secret pre-fetch block in the old `ResolveCredentials`.
- `os` import (unless still used by other code in the file — verify).
- `regexp` import if unused after the deletions.

**Signature change.** `ResolveCredentials` drops the `tenantId string` parameter — no tenant-scoped resolution means no need for it. Call sites in `go/internal/operator/translator.go` and any workload controller code passing `tenantId` get updated.

## Migration of existing workload YAMLs

### `workloads/claude-code.yaml`

```yaml
# before
credentials:
  - domain: api.anthropic.com
    headers:
      x-api-key: "${tenant-secret:ANTHROPIC_API_KEY}"

# after
credentials:
  # Prereq:
  #   kubectl -n boilerhouse create secret generic anthropic-api \
  #     --from-literal=key="<your Anthropic API key>"
  - domain: api.anthropic.com
    headers:
      - name: x-api-key
        valueFrom:
          secretKeyRef:
            name: anthropic-api
            key: key
```

### `workloads/openclaw.yaml`

Identical change to the same credential. Prereq comment added once at the top of the credentials block.

Both files get the header comment so users know which Secret to create before applying.

## Deletions beyond resolver + CRD

### Per-tenant Secret API surface — removed entirely

- `go/internal/api/routes_secret.go` — the file and all handlers (`setSecret`, `listSecrets`, `deleteSecret`, `getSecret`).
- `go/internal/api/routes_secret_test.go` (if present).
- `secretName` helper function.
- Route registrations in `go/internal/api/server.go` (the `/api/v1/tenants/:id/secrets` chi.Router subtree and anything adjacent that used `secretName`).

### Dashboard

`ts/apps/dashboard/src/api.ts` and any page under `ts/apps/dashboard/src/pages/` that called the deleted endpoints. Grep for `tenantSecret`, `/secrets`, `setSecret`, `listSecrets` before and after the deletions. Any nav entry pointing at a removed page gets pruned from the sidebar.

### Tests

Deleted from `go/internal/operator/sidecar_test.go`:

- `TestResolveCredentials_GlobalSecret`
- `TestResolveCredentials_TenantSecret`
- `TestResolveCredentials_MixedSecrets`

`TestResolveCredentials_SkipsEmptyDomain` is preserved but reshaped — the `headers` field now takes `[]HeaderEntry` instead of `*runtime.RawExtension`.

## Tests — new

All new tests use envtest + real `corev1.Secret` objects (same pattern as the preserved `TestResolveCredentials_SkipsEmptyDomain`).

- `TestResolveCredentials_Literal` — `{name: x, value: "literal"}`; asserts resolved headers map + that the client was never called.
- `TestResolveCredentials_SecretKeyRef` — Secret `anthropic-api` with `key=sk-ant-123`; credential uses valueFrom.secretKeyRef; asserts the resolved value.
- `TestResolveCredentials_MixedLiteralAndRef` — one credential, two headers: one literal, one ref. Both resolve in one call.
- `TestResolveCredentials_SecretNotFound` — secretKeyRef to a non-existent Secret; asserts the error mentions both the credential domain and the header name.
- `TestResolveCredentials_KeyNotFound` — Secret exists, key missing; asserts the error mentions the key.
- `TestResolveCredentials_RejectsBothValueAndValueFrom` — validation error.
- `TestResolveCredentials_RejectsNeitherValueNorValueFrom` — validation error.
- `TestResolveCredentials_MissingName` — empty header name; validation error.
- `TestResolveCredentials_SharedSecretFetchedOnce` — two credentials referencing the same Secret (different keys). Wraps the fake client to count `Get` calls; asserts exactly 1 fetch.

Workload-controller and API-server tests that reference the old `Headers *runtime.RawExtension` shape or tenant-secret routes get updated or deleted as needed during the implementation pass.

## Error semantics

All resolver errors fail the reconcile cycle for the affected Workload. Envoy config for that workload is not emitted; the workload's `Status.Phase` moves to `Error` with the error string. Same failure mode as the current tenant-secret path — users debug via workload status, not cluster-wide logs.

Specific error messages:

- `credential for domain <d>: header entry missing name`
- `credential for domain <d>: header "<n>" has neither value nor valueFrom`
- `credential for domain <d>: header "<n>" sets both value and valueFrom`
- `credential for domain <d>, header "<n>": secret "<name>": <underlying k8s error>`
- `credential for domain <d>, header "<n>": secret "<name>": key "<key>" not found`

## Risks

- **Breaking change.** Any workload YAML written against the old template-string schema stops applying cleanly. Mitigation: only two committed YAMLs use the old syntax; both are migrated in the same change. External users in this pre-release period get a one-line migration note in the commit message.
- **Runtime-only validation.** Headers that violate `value XOR valueFrom` aren't rejected by the API server (no OpenAPI `oneOf`). They pass `kubectl apply` and fail at reconcile. Acceptable trade-off; an admission webhook is a follow-up.
- **Deleting the tenant-secrets API surface.** If the dashboard has UI surfacing it today, that UI goes away in the same change. Section "Dashboard" above calls out the grep. If anyone external was relying on the REST API, they lose it — pre-release disclaimer stands.
