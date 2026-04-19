# K8s-Native Credential Injection Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the string-template credential injection (`${tenant-secret:...}`, `${global-secret:...}`) on `BoilerhouseWorkload.network.credentials[].headers` with a K8s-native structured schema: each header is either a literal `value` or a `valueFrom.secretKeyRef` against a Secret in the operator's namespace.

**Architecture:** Three-task change. Task 1 is the core atomic change — CRD types + resolver + tests + callers — so the module builds green at every commit. Task 2 deletes the per-tenant Secret REST API surface (no longer consumed). Task 3 migrates the two existing workload YAMLs to the new schema.

**Tech Stack:** Go 1.26, kubebuilder / controller-tools for CRD codegen, controller-runtime envtest for tests.

---

## Preconditions

- [ ] **Confirm clean working tree on the feature branch.** Run:
  ```bash
  cd /Users/z/work/boilerhouse
  git status
  ```
  Uncommitted changes on unrelated files (claim resilience) are fine. No edits to any file this plan touches.

- [ ] **Confirm the commands that regenerate code.** The project uses `controller-gen` invoked via `go run`:
  ```bash
  cd /Users/z/work/boilerhouse/go
  go run sigs.k8s.io/controller-tools/cmd/controller-gen object paths="./api/..."
  go run sigs.k8s.io/controller-tools/cmd/controller-gen crd paths="./api/..." output:crd:artifacts:config=../config/crd/bases-go
  ```
  Run them once before starting to warm the module cache. Expected: no errors, files may change slightly as the generator canonicalises formatting. Discard any incidental changes (`git checkout -- .`) before the real task begins.

- [ ] **Confirm envtest works.** Run:
  ```bash
  cd /Users/z/work/boilerhouse/go
  export KUBEBUILDER_ASSETS="$("$(go env GOPATH)/bin/setup-envtest" use -p path)"
  go test ./internal/operator/ -run TestResolveCredentials_TenantSecret -count=1 -timeout 180s
  ```
  Expected: PASS. This test is getting deleted in Task 1 but must be green before we start.

- [ ] **Confirm no dashboard code references tenant-secret REST.** Run:
  ```bash
  cd /Users/z/work/boilerhouse
  grep -ri 'secret' ts/apps/dashboard/src/ 2>/dev/null
  ```
  Expected: no matches. If any hit appears, stop and escalate — Task 2 would need to remove the dashboard callers too.

---

## Task 1: CRD types, resolver, and tests (single atomic change)

Updates the Go types, regenerates codegen, rewrites the resolver, updates its call site, replaces the test suite. Single commit so the module stays buildable.

**Files:**
- Modify: `go/api/v1alpha1/workload_types.go`
- Modify (regenerated): `go/api/v1alpha1/zz_generated.deepcopy.go`
- Modify (regenerated): `config/crd/bases-go/boilerhouse.dev_boilerhouseworkloads.yaml`
- Modify: `go/internal/operator/sidecar.go`
- Modify: `go/internal/operator/sidecar_test.go`
- Modify: `go/internal/operator/claim_controller.go`

- [ ] **Step 1: Update the Go CRD types.**

Open `go/api/v1alpha1/workload_types.go`. Replace the `NetworkCredential` struct and add the three new types. After the edit the section reads:

```go
// NetworkCredential defines credentials for a domain.
type NetworkCredential struct {
	// Domain is the domain to apply credentials to.
	// +optional
	Domain string `json:"domain,omitempty"`
	// Headers to inject on requests to Domain.
	// +optional
	Headers []HeaderEntry `json:"headers,omitempty"`
}

// HeaderEntry is one injected header. Exactly one of Value or ValueFrom must
// be set.
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

Also remove the now-unused `runtime` import at the top of the file if no other declaration uses it:

```bash
grep -n 'runtime\.' go/api/v1alpha1/workload_types.go
```

If the only hit was on the deleted `Headers *runtime.RawExtension`, delete `"k8s.io/apimachinery/pkg/runtime"` from the import block.

- [ ] **Step 2: Regenerate deepcopy code.**

```bash
cd /Users/z/work/boilerhouse/go
go run sigs.k8s.io/controller-tools/cmd/controller-gen object paths="./api/..."
```

Expected: `go/api/v1alpha1/zz_generated.deepcopy.go` updates — old `NetworkCredential.SecretRef` DeepCopyInto block replaced with new `Headers` list block, new `DeepCopy*` functions for `HeaderEntry` and `HeaderValueSource`. The `SecretKeyRef` block stays.

- [ ] **Step 3: Regenerate the CRD YAML.**

```bash
cd /Users/z/work/boilerhouse/go
go run sigs.k8s.io/controller-tools/cmd/controller-gen crd paths="./api/..." output:crd:artifacts:config=../config/crd/bases-go
```

Expected: `config/crd/bases-go/boilerhouse.dev_boilerhouseworkloads.yaml` updates — the `headers` OpenAPI schema changes from a loose `x-kubernetes-preserve-unknown-fields: true` object to a typed `array` of `HeaderEntry` objects. `secretRef` is gone at the credential level.

- [ ] **Step 4: Verify the build after type changes.**

```bash
cd /Users/z/work/boilerhouse/go
go build ./...
```

Expected: build fails — `sidecar.go` and `claim_controller.go` reference the old `Headers *runtime.RawExtension` / `tenantId` signature. That's fine; those get fixed in the next steps.

- [ ] **Step 5: Rewrite `sidecar.go` — `ResolveCredentials` + helpers.**

Open `go/internal/operator/sidecar.go`. Replace the existing credential-resolution block (everything from `var ( globalSecretRe ...` through the end of `resolveValue`) with the structured resolver below. Keep `InjectSidecar` and its related code untouched.

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

After this edit, the imports at the top of `sidecar.go` should no longer need `os` or `regexp` or `strings`. Check and trim:

```bash
grep -n '\b\(os\|regexp\|strings\)\.' go/internal/operator/sidecar.go
```

Remove unused imports from the import block. `encoding/json` may also become unused — check and remove if so.

- [ ] **Step 6: Update the `ResolveCredentials` call site in `claim_controller.go`.**

Open `go/internal/operator/claim_controller.go` and find line 264 (or `grep -n 'ResolveCredentials' go/internal/operator/claim_controller.go`). Change:

```go
resolved, err := ResolveCredentials(ctx, r.Client, claim.Namespace, claim.Spec.TenantId, wl.Spec.Network.Credentials)
```

to:

```go
resolved, err := ResolveCredentials(ctx, r.Client, claim.Namespace, wl.Spec.Network.Credentials)
```

The `tenantId` argument is dropped — the new signature doesn't take it. No other logic changes here.

- [ ] **Step 7: Replace the test suite in `sidecar_test.go`.**

Open `go/internal/operator/sidecar_test.go`. Delete these four tests entirely:

- `TestResolveCredentials_GlobalSecret`
- `TestResolveCredentials_TenantSecret`
- `TestResolveCredentials_MixedSecrets`
- `TestResolveCredentials_SkipsEmptyDomain`  *(will be replaced by a new version below)*

Also remove the `"os"` import from the top of the file if no other test uses it:

```bash
grep -n '\bos\.' go/internal/operator/sidecar_test.go
```

Then append the following tests (after `TestInjectSidecar` and any existing imports block):

```go
func TestResolveCredentials_Literal(t *testing.T) {
	// No K8s client needed — no secret refs. Passing nil forces a panic if
	// the resolver tries to fetch anything.
	credentials := []v1alpha1.NetworkCredential{
		{
			Domain: "api.example.com",
			Headers: []v1alpha1.HeaderEntry{
				{Name: "x-static", Value: "literal"},
			},
		},
	}

	resolved, err := ResolveCredentials(context.Background(), nil, "default", credentials)
	require.NoError(t, err)
	require.Len(t, resolved, 1)
	assert.Equal(t, "api.example.com", resolved[0].Domain)
	assert.Equal(t, "literal", resolved[0].Headers["x-static"])
}

func TestResolveCredentials_SecretKeyRef(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "anthropic-api",
			Namespace: "default",
		},
		Data: map[string][]byte{"key": []byte("sk-ant-123")},
	}
	require.NoError(t, k8sClient.Create(ctx, secret))

	credentials := []v1alpha1.NetworkCredential{
		{
			Domain: "api.anthropic.com",
			Headers: []v1alpha1.HeaderEntry{
				{
					Name: "x-api-key",
					ValueFrom: &v1alpha1.HeaderValueSource{
						SecretKeyRef: &v1alpha1.SecretKeyRef{Name: "anthropic-api", Key: "key"},
					},
				},
			},
		},
	}

	resolved, err := ResolveCredentials(ctx, k8sClient, "default", credentials)
	require.NoError(t, err)
	require.Len(t, resolved, 1)
	assert.Equal(t, "sk-ant-123", resolved[0].Headers["x-api-key"])
}

func TestResolveCredentials_MixedLiteralAndRef(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "s", Namespace: "default"},
		Data:       map[string][]byte{"k": []byte("from-secret")},
	}
	require.NoError(t, k8sClient.Create(ctx, secret))

	credentials := []v1alpha1.NetworkCredential{
		{
			Domain: "api.example.com",
			Headers: []v1alpha1.HeaderEntry{
				{Name: "x-static", Value: "literal"},
				{
					Name: "x-dynamic",
					ValueFrom: &v1alpha1.HeaderValueSource{
						SecretKeyRef: &v1alpha1.SecretKeyRef{Name: "s", Key: "k"},
					},
				},
			},
		},
	}

	resolved, err := ResolveCredentials(ctx, k8sClient, "default", credentials)
	require.NoError(t, err)
	require.Len(t, resolved, 1)
	assert.Equal(t, "literal", resolved[0].Headers["x-static"])
	assert.Equal(t, "from-secret", resolved[0].Headers["x-dynamic"])
}

func TestResolveCredentials_SecretNotFound(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	credentials := []v1alpha1.NetworkCredential{
		{
			Domain: "api.example.com",
			Headers: []v1alpha1.HeaderEntry{
				{
					Name: "x-api-key",
					ValueFrom: &v1alpha1.HeaderValueSource{
						SecretKeyRef: &v1alpha1.SecretKeyRef{Name: "missing-secret", Key: "key"},
					},
				},
			},
		},
	}

	_, err := ResolveCredentials(ctx, k8sClient, "default", credentials)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "api.example.com")
	assert.Contains(t, err.Error(), "x-api-key")
	assert.Contains(t, err.Error(), "missing-secret")
}

func TestResolveCredentials_KeyNotFound(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "s", Namespace: "default"},
		Data:       map[string][]byte{"wrong": []byte("v")},
	}
	require.NoError(t, k8sClient.Create(ctx, secret))

	credentials := []v1alpha1.NetworkCredential{
		{
			Domain: "api.example.com",
			Headers: []v1alpha1.HeaderEntry{
				{
					Name: "x-api-key",
					ValueFrom: &v1alpha1.HeaderValueSource{
						SecretKeyRef: &v1alpha1.SecretKeyRef{Name: "s", Key: "key"},
					},
				},
			},
		},
	}

	_, err := ResolveCredentials(ctx, k8sClient, "default", credentials)
	require.Error(t, err)
	assert.Contains(t, err.Error(), `"key"`)
}

func TestResolveCredentials_RejectsBothValueAndValueFrom(t *testing.T) {
	credentials := []v1alpha1.NetworkCredential{
		{
			Domain: "api.example.com",
			Headers: []v1alpha1.HeaderEntry{
				{
					Name:  "x",
					Value: "literal",
					ValueFrom: &v1alpha1.HeaderValueSource{
						SecretKeyRef: &v1alpha1.SecretKeyRef{Name: "s", Key: "k"},
					},
				},
			},
		},
	}

	_, err := ResolveCredentials(context.Background(), nil, "default", credentials)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "both value and valueFrom")
}

func TestResolveCredentials_RejectsNeitherValueNorValueFrom(t *testing.T) {
	credentials := []v1alpha1.NetworkCredential{
		{
			Domain: "api.example.com",
			Headers: []v1alpha1.HeaderEntry{
				{Name: "x"},
			},
		},
	}

	_, err := ResolveCredentials(context.Background(), nil, "default", credentials)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "neither value nor valueFrom")
}

func TestResolveCredentials_MissingName(t *testing.T) {
	credentials := []v1alpha1.NetworkCredential{
		{
			Domain: "api.example.com",
			Headers: []v1alpha1.HeaderEntry{
				{Value: "literal"},
			},
		},
	}

	_, err := ResolveCredentials(context.Background(), nil, "default", credentials)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "missing name")
}

func TestResolveCredentials_SharedSecretFetchedOnce(t *testing.T) {
	ctx, baseClient, cleanup := setupEnvtest(t)
	defer cleanup()

	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "shared", Namespace: "default"},
		Data: map[string][]byte{
			"a": []byte("val-a"),
			"b": []byte("val-b"),
		},
	}
	require.NoError(t, baseClient.Create(ctx, secret))

	wrapped := &countingClient{Client: baseClient}

	credentials := []v1alpha1.NetworkCredential{
		{
			Domain: "api.one.com",
			Headers: []v1alpha1.HeaderEntry{
				{
					Name: "x-a",
					ValueFrom: &v1alpha1.HeaderValueSource{
						SecretKeyRef: &v1alpha1.SecretKeyRef{Name: "shared", Key: "a"},
					},
				},
			},
		},
		{
			Domain: "api.two.com",
			Headers: []v1alpha1.HeaderEntry{
				{
					Name: "x-b",
					ValueFrom: &v1alpha1.HeaderValueSource{
						SecretKeyRef: &v1alpha1.SecretKeyRef{Name: "shared", Key: "b"},
					},
				},
			},
		},
	}

	resolved, err := ResolveCredentials(ctx, wrapped, "default", credentials)
	require.NoError(t, err)
	require.Len(t, resolved, 2)
	assert.Equal(t, "val-a", resolved[0].Headers["x-a"])
	assert.Equal(t, "val-b", resolved[1].Headers["x-b"])
	assert.Equal(t, 1, wrapped.secretGets, "expected 1 Secret Get, got %d", wrapped.secretGets)
}

func TestResolveCredentials_SkipsEmptyDomain(t *testing.T) {
	credentials := []v1alpha1.NetworkCredential{
		{
			Domain: "",
			Headers: []v1alpha1.HeaderEntry{
				{Name: "x", Value: "literal"},
			},
		},
		{
			Domain: "api.valid.com",
			Headers: []v1alpha1.HeaderEntry{
				{Name: "x", Value: "kept"},
			},
		},
	}

	resolved, err := ResolveCredentials(context.Background(), nil, "default", credentials)
	require.NoError(t, err)
	require.Len(t, resolved, 1)
	assert.Equal(t, "api.valid.com", resolved[0].Domain)
	assert.Equal(t, "kept", resolved[0].Headers["x"])
}
```

The `countingClient` wrapper counts calls to `Get` with a `corev1.Secret` target. Add this helper to the same file, outside the test functions:

```go
// countingClient wraps a controller-runtime client and counts Get calls that
// target a corev1.Secret. Used by TestResolveCredentials_SharedSecretFetchedOnce.
type countingClient struct {
	client.Client
	secretGets int
}

func (c *countingClient) Get(ctx context.Context, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
	if _, ok := obj.(*corev1.Secret); ok {
		c.secretGets++
	}
	return c.Client.Get(ctx, key, obj, opts...)
}
```

Add the following to the import block of the test file if not already present:

```go
"sigs.k8s.io/controller-runtime/pkg/client"
```

- [ ] **Step 8: Run the operator tests.**

```bash
cd /Users/z/work/boilerhouse/go
export KUBEBUILDER_ASSETS="$("$(go env GOPATH)/bin/setup-envtest" use -p path)"
go test ./internal/operator/ -run 'TestResolveCredentials' -count=1 -v -timeout 180s
```

Expected: all nine new tests PASS. No tests using the old templating syntax appear in the output.

- [ ] **Step 9: Build and vet the whole module.**

```bash
cd /Users/z/work/boilerhouse/go
go build ./...
go vet ./...
```

Expected: both clean. If build fails on a file this plan hasn't touched, check whether it was referencing `NetworkCredential.SecretRef` or the old `Headers` RawExtension and fix accordingly.

- [ ] **Step 10: Run the full operator test suite.**

```bash
cd /Users/z/work/boilerhouse/go
export KUBEBUILDER_ASSETS="$("$(go env GOPATH)/bin/setup-envtest" use -p path)"
go test ./internal/operator/ -count=1 -timeout 300s
```

Expected: all tests PASS.

- [ ] **Step 11: Commit.**

```bash
cd /Users/z/work/boilerhouse
git add go/api/v1alpha1/workload_types.go \
        go/api/v1alpha1/zz_generated.deepcopy.go \
        config/crd/bases-go/boilerhouse.dev_boilerhouseworkloads.yaml \
        go/internal/operator/sidecar.go \
        go/internal/operator/sidecar_test.go \
        go/internal/operator/claim_controller.go
git commit -m "feat(operator): K8s-native credential injection schema"
```

---

## Task 2: Remove per-tenant Secret REST API

`bh-secret-<tenantId>` Secrets are no longer consumed by anything. Delete the REST surface that managed them.

**Files:**
- Delete: `go/internal/api/routes_secret.go`
- Modify: `go/internal/api/server.go`
- Possibly modify: `go/internal/api/server_test.go` (if tests reference the removed routes)

- [ ] **Step 1: Check for test references.**

```bash
cd /Users/z/work/boilerhouse/go
grep -n 'setSecret\|listSecrets\|deleteSecret\|secretName\|/secrets' internal/api/*_test.go
```

Note every file + line. If nothing matches, skip test cleanup. If something matches, the corresponding assertions / test helpers get deleted as part of this task.

- [ ] **Step 2: Remove the route registrations from `server.go`.**

Open `go/internal/api/server.go` and find the block around line 102-105:

```go
// Secrets
r.Put("/tenants/{id}/secrets/{name}", s.setSecret)
r.Get("/tenants/{id}/secrets", s.listSecrets)
r.Delete("/tenants/{id}/secrets/{name}", s.deleteSecret)
```

Delete those four lines (including the `// Secrets` comment).

- [ ] **Step 3: Delete the routes file.**

```bash
cd /Users/z/work/boilerhouse
rm go/internal/api/routes_secret.go
```

- [ ] **Step 4: If tests referenced the removed routes, clean them up.**

Re-run the grep from Step 1:

```bash
cd /Users/z/work/boilerhouse/go
grep -n 'setSecret\|listSecrets\|deleteSecret\|secretName\|/secrets' internal/api/*.go internal/api/*_test.go
```

Expected: empty output. If anything remains, delete the referencing test function or assertion. `secretName` should be gone with the deleted file; if a test helper still references it, that test is obsolete.

- [ ] **Step 5: Build and vet.**

```bash
cd /Users/z/work/boilerhouse/go
go build ./...
go vet ./...
```

Expected: both clean.

- [ ] **Step 6: Run the API test suite.**

```bash
cd /Users/z/work/boilerhouse/go
export KUBEBUILDER_ASSETS="$("$(go env GOPATH)/bin/setup-envtest" use -p path)"
go test ./internal/api/ -count=1 -timeout 180s
```

Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
cd /Users/z/work/boilerhouse
git add go/internal/api/server.go
git add -u go/internal/api/
git status
git commit -m "refactor(api): remove per-tenant Secret REST endpoints"
```

The `git add -u` picks up the deleted `routes_secret.go`. `git status` between add and commit is there so the human executing the plan can eyeball exactly what's staged.

---

## Task 3: Migrate workload YAMLs

Two files still use the old `"${tenant-secret:ANTHROPIC_API_KEY}"` templating. Update both to the new structured schema.

**Files:**
- Modify: `workloads/claude-code.yaml`
- Modify: `workloads/openclaw.yaml`

- [ ] **Step 1: Verify current state of both files.**

```bash
cd /Users/z/work/boilerhouse
grep -n 'tenant-secret' workloads/claude-code.yaml workloads/openclaw.yaml
```

Expected: exactly one hit per file, both of the form `x-api-key: "${tenant-secret:ANTHROPIC_API_KEY}"`. If the count differs, stop and re-read the spec.

- [ ] **Step 2: Update `workloads/claude-code.yaml`.**

Find the `credentials:` block (currently around lines 26-29):

```yaml
    credentials:
      - domain: api.anthropic.com
        headers:
          x-api-key: "${tenant-secret:ANTHROPIC_API_KEY}"
```

Replace with:

```yaml
    # Prereq: create the Secret this trigger's credential references before applying:
    #   kubectl -n boilerhouse create secret generic anthropic-api \
    #     --from-literal=key="<your Anthropic API key>"
    credentials:
      - domain: api.anthropic.com
        headers:
          - name: x-api-key
            valueFrom:
              secretKeyRef:
                name: anthropic-api
                key: key
```

- [ ] **Step 3: Update `workloads/openclaw.yaml`.**

Same replacement — find the identical `credentials` block and swap to the structured form with the same prereq comment.

- [ ] **Step 4: Verify no old syntax remains in any committed YAML.**

```bash
cd /Users/z/work/boilerhouse
grep -rE '\$\{(tenant-secret|global-secret|secret):' --include='*.yaml' --include='*.yml' . | grep -v '\.worktrees/'
```

Expected: empty. Any match means a YAML still uses templating and needs updating.

- [ ] **Step 5: Validate both YAMLs parse against the new CRD schema.**

```bash
cd /Users/z/work/boilerhouse
kubectl apply --dry-run=client --validate=false -f workloads/claude-code.yaml
kubectl apply --dry-run=client --validate=false -f workloads/openclaw.yaml
```

Expected: both print `created (dry run)` or equivalent. `--validate=false` skips server-side schema validation since the cluster CRD may not yet be updated.

- [ ] **Step 6: Commit.**

```bash
cd /Users/z/work/boilerhouse
git add workloads/claude-code.yaml workloads/openclaw.yaml
git commit -m "docs(workloads): migrate credentials to secretKeyRef schema"
```

---

## Self-Review Notes

Before marking complete:

- **Schema + resolver consistency.** Task 1's `HeaderEntry` Go type shape matches the YAML shape used in Task 3's migrated workloads. If the migrated YAML uses fields the resolver doesn't implement, both need fixing.
- **Signature change ripple.** `ResolveCredentials` dropped `tenantId`. Only `claim_controller.go` calls it outside tests — if `go build` complains about a second caller, thread through there too.
- **No stale templating.** Task 3 Step 4's grep must return empty. If a third YAML elsewhere in the repo uses the old syntax, Task 3 has an uncovered file.
- **Dashboard untouched.** Precondition step confirmed no dashboard code references tenant-secrets. If that assumption was wrong, Task 2 was incomplete.
- **CRD regenerated.** `config/crd/bases-go/boilerhouse.dev_boilerhouseworkloads.yaml`'s `headers` field is now `array` of structured objects, not `x-kubernetes-preserve-unknown-fields: true`.
