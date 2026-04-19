# `${secret:...}` Credential Injection Syntax Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the env-var-backed `${global-secret:NAME}` credential-injection syntax with a K8s-Secret-backed `${secret:[NAMESPACE/]NAME:KEY}` syntax, keeping `${tenant-secret:NAME}` unchanged.

**Architecture:** Single-file change to `go/internal/operator/sidecar.go`: new regex, new pre-fetch+cache loop, delete the old env-var branch. Tests in `sidecar_test.go` are reshaped to use envtest-backed K8s Secrets instead of `os.Setenv`. Docs cover the cross-namespace RBAC escape hatch. No workload YAML touches any of the new syntax today, so the migration is code-only.

**Tech Stack:** Go, controller-runtime fake client / envtest, `regexp`, stdlib.

---

## Preconditions

- [ ] **Confirm working dir is clean.** Run:
  ```bash
  cd /Users/z/work/boilerhouse
  git status
  ```
  Expect unstaged changes unrelated to this work are fine (they exist on main), but no uncommitted edits to `go/internal/operator/sidecar.go` or `go/internal/operator/sidecar_test.go`.

- [ ] **Confirm no committed YAML uses the old syntax.** Run:
  ```bash
  grep -rE '\$\{global-secret:' --include='*.yaml' --include='*.yml' .
  ```
  Expected output: empty. If any match is found, stop and escalate — the plan assumes there are no migrations to perform.

- [ ] **Confirm envtest works.** The resolver tests now need a fake K8s client. Run a sanity build:
  ```bash
  cd /Users/z/work/boilerhouse/go
  go test ./internal/operator/ -run TestResolveCredentials_TenantSecret -count=1
  ```
  Expected: PASS. (This test already uses envtest.)

---

## Task 1: Add `${secret:[NAMESPACE/]NAME:KEY}` resolver

Pre-scan credential header values for the new syntax, pre-fetch every referenced Secret once, cache by `namespace/name`, then substitute during `resolveValue`. `${global-secret:...}` is still supported at the end of this task — it gets removed in Task 2.

**Files:**
- Modify: `go/internal/operator/sidecar.go`
- Modify: `go/internal/operator/sidecar_test.go`

- [ ] **Step 1: Write failing tests for the new syntax (default namespace).**

Append to `go/internal/operator/sidecar_test.go`:

```go
func TestResolveCredentials_SecretSyntax_DefaultNamespace(t *testing.T) {
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

	headersRaw, _ := json.Marshal(map[string]string{
		"x-api-key": "${secret:anthropic-api:key}",
	})

	credentials := []v1alpha1.NetworkCredential{
		{
			Domain:  "api.anthropic.com",
			Headers: &runtime.RawExtension{Raw: headersRaw},
		},
	}

	resolved, err := ResolveCredentials(ctx, k8sClient, "default", "tenant-1", credentials)
	require.NoError(t, err)
	require.Len(t, resolved, 1)
	assert.Equal(t, "sk-ant-123", resolved[0].Headers["x-api-key"])
}

func TestResolveCredentials_SecretSyntax_ExplicitNamespace(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	// Create the target namespace first.
	ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "shared"}}
	require.NoError(t, k8sClient.Create(ctx, ns))

	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "org-info",
			Namespace: "shared",
		},
		Data: map[string][]byte{"org-id": []byte("org-42")},
	}
	require.NoError(t, k8sClient.Create(ctx, secret))

	headersRaw, _ := json.Marshal(map[string]string{
		"x-org-id": "${secret:shared/org-info:org-id}",
	})

	credentials := []v1alpha1.NetworkCredential{
		{
			Domain:  "api.example.com",
			Headers: &runtime.RawExtension{Raw: headersRaw},
		},
	}

	resolved, err := ResolveCredentials(ctx, k8sClient, "default", "tenant-1", credentials)
	require.NoError(t, err)
	require.Len(t, resolved, 1)
	assert.Equal(t, "org-42", resolved[0].Headers["x-org-id"])
}

func TestResolveCredentials_SecretSyntax_MissingSecret(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	headersRaw, _ := json.Marshal(map[string]string{
		"x-api-key": "${secret:does-not-exist:key}",
	})

	credentials := []v1alpha1.NetworkCredential{
		{
			Domain:  "api.example.com",
			Headers: &runtime.RawExtension{Raw: headersRaw},
		},
	}

	_, err := ResolveCredentials(ctx, k8sClient, "default", "tenant-1", credentials)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "does-not-exist")
}

func TestResolveCredentials_SecretSyntax_MissingKey(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "anthropic-api",
			Namespace: "default",
		},
		Data: map[string][]byte{"different-key": []byte("v")},
	}
	require.NoError(t, k8sClient.Create(ctx, secret))

	headersRaw, _ := json.Marshal(map[string]string{
		"x-api-key": "${secret:anthropic-api:key}",
	})

	credentials := []v1alpha1.NetworkCredential{
		{
			Domain:  "api.example.com",
			Headers: &runtime.RawExtension{Raw: headersRaw},
		},
	}

	_, err := ResolveCredentials(ctx, k8sClient, "default", "tenant-1", credentials)
	require.Error(t, err)
	assert.Contains(t, err.Error(), `"key"`)
}

func TestResolveCredentials_CombinedTenantAndSecret(t *testing.T) {
	ctx, k8sClient, cleanup := setupEnvtest(t)
	defer cleanup()

	tenantSecret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "bh-secret-alice", Namespace: "default"},
		Data:       map[string][]byte{"API_KEY": []byte("alice-key")},
	}
	globalLike := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "anthropic-api", Namespace: "default"},
		Data:       map[string][]byte{"key": []byte("sk-ant-global")},
	}
	require.NoError(t, k8sClient.Create(ctx, tenantSecret))
	require.NoError(t, k8sClient.Create(ctx, globalLike))

	headersRaw, _ := json.Marshal(map[string]string{
		"x-tenant-key": "${tenant-secret:API_KEY}",
		"x-api-key":    "${secret:anthropic-api:key}",
	})

	credentials := []v1alpha1.NetworkCredential{
		{
			Domain:  "api.mixed.com",
			Headers: &runtime.RawExtension{Raw: headersRaw},
		},
	}

	resolved, err := ResolveCredentials(ctx, k8sClient, "default", "alice", credentials)
	require.NoError(t, err)
	require.Len(t, resolved, 1)
	assert.Equal(t, "alice-key", resolved[0].Headers["x-tenant-key"])
	assert.Equal(t, "sk-ant-global", resolved[0].Headers["x-api-key"])
}
```

- [ ] **Step 2: Run the new tests — expect failures.**

```bash
cd /Users/z/work/boilerhouse/go
go test ./internal/operator/ -run 'TestResolveCredentials_SecretSyntax|TestResolveCredentials_CombinedTenantAndSecret' -count=1
```

Expected: failures. The `${secret:...}` substrings will appear literally in the resolved headers because no regex matches them yet.

- [ ] **Step 3: Add the regex, pre-fetch, and substitution logic.**

In `go/internal/operator/sidecar.go`, at the top of the file where `globalSecretRe` and `tenantSecretRe` are declared (around line 111), add the new regex:

```go
var (
	globalSecretRe = regexp.MustCompile(`\$\{global-secret:([^}]+)\}`)
	tenantSecretRe = regexp.MustCompile(`\$\{tenant-secret:([^}]+)\}`)
	secretRe       = regexp.MustCompile(`\$\{secret:(?:([^/}:]+)/)?([^:}]+):([^}]+)\}`)
)
```

Replace the `ResolveCredentials` function body (currently lines 119-172) with the version that also pre-fetches `${secret:...}` references:

```go
// ResolveCredentials resolves secret references in workload credential headers.
// ${tenant-secret:NAME} is resolved from a K8s Secret named "bh-secret-<tenantId>".
// ${secret:[NAMESPACE/]NAME:KEY} is resolved from an arbitrary K8s Secret
// (namespace defaults to the operator's namespace).
func ResolveCredentials(ctx context.Context, k8sClient client.Client, namespace string, tenantId string, credentials []v1alpha1.NetworkCredential) ([]envoy.ResolvedCredential, error) {
	// Pre-fetch tenant secret (if any credential uses tenant-secret references).
	var tenantSecretData map[string][]byte
	tenantSecretNeeded := false
	for _, cred := range credentials {
		if cred.Headers != nil && cred.Headers.Raw != nil {
			raw := string(cred.Headers.Raw)
			if strings.Contains(raw, "${tenant-secret:") {
				tenantSecretNeeded = true
				break
			}
		}
	}
	if tenantSecretNeeded && tenantId != "" {
		secretName := fmt.Sprintf("bh-secret-%s", tenantId)
		var secret corev1.Secret
		err := k8sClient.Get(ctx, types.NamespacedName{Name: secretName, Namespace: namespace}, &secret)
		if err != nil {
			return nil, fmt.Errorf("fetching tenant secret %s: %w", secretName, err)
		}
		tenantSecretData = secret.Data
	}

	// Pre-fetch every distinct ${secret:NS/NAME:KEY} Secret. Fail if any
	// referenced Secret is missing or any referenced KEY is absent.
	secretCache, err := prefetchSecrets(ctx, k8sClient, namespace, credentials)
	if err != nil {
		return nil, err
	}

	var resolved []envoy.ResolvedCredential
	for _, cred := range credentials {
		if cred.Domain == "" {
			continue
		}

		headers := make(map[string]string)
		if cred.Headers != nil && cred.Headers.Raw != nil {
			var raw map[string]string
			if err := json.Unmarshal(cred.Headers.Raw, &raw); err != nil {
				return nil, fmt.Errorf("parsing headers for domain %s: %w", cred.Domain, err)
			}

			for key, val := range raw {
				resolvedVal, err := resolveValue(val, tenantSecretData, secretCache, namespace)
				if err != nil {
					return nil, fmt.Errorf("resolving header %s for domain %s: %w", key, cred.Domain, err)
				}
				headers[key] = resolvedVal
			}
		}

		resolved = append(resolved, envoy.ResolvedCredential{
			Domain:  cred.Domain,
			Headers: headers,
		})
	}

	return resolved, nil
}

// prefetchSecrets walks every credential header value for ${secret:...}
// references, fetches each distinct Secret once, and validates every
// referenced KEY exists. Returns a map keyed by "namespace/name".
func prefetchSecrets(ctx context.Context, k8sClient client.Client, operatorNs string, credentials []v1alpha1.NetworkCredential) (map[string]map[string][]byte, error) {
	cache := map[string]map[string][]byte{}
	// needed keys per secret: "namespace/name" -> set of keys
	needed := map[string]map[string]struct{}{}

	for _, cred := range credentials {
		if cred.Headers == nil || cred.Headers.Raw == nil {
			continue
		}
		matches := secretRe.FindAllStringSubmatch(string(cred.Headers.Raw), -1)
		for _, m := range matches {
			ns := m[1]
			if ns == "" {
				ns = operatorNs
			}
			name := m[2]
			key := m[3]
			id := ns + "/" + name
			if needed[id] == nil {
				needed[id] = map[string]struct{}{}
			}
			needed[id][key] = struct{}{}
		}
	}

	for id, keys := range needed {
		slash := strings.Index(id, "/")
		ns, name := id[:slash], id[slash+1:]

		var secret corev1.Secret
		err := k8sClient.Get(ctx, types.NamespacedName{Name: name, Namespace: ns}, &secret)
		if err != nil {
			return nil, fmt.Errorf("secret %s: %w", id, err)
		}

		for key := range keys {
			if _, ok := secret.Data[key]; !ok {
				return nil, fmt.Errorf("secret %s: key %q not found", id, key)
			}
		}

		cache[id] = secret.Data
	}

	return cache, nil
}
```

Replace `resolveValue` (currently lines 175-202) with:

```go
// resolveValue replaces ${global-secret:NAME}, ${tenant-secret:NAME}, and
// ${secret:[NAMESPACE/]NAME:KEY} references.
func resolveValue(val string, tenantSecretData map[string][]byte, secretCache map[string]map[string][]byte, operatorNs string) (string, error) {
	// Resolve global secrets from env. (Removed in Task 2.)
	result := globalSecretRe.ReplaceAllStringFunc(val, func(match string) string {
		parts := globalSecretRe.FindStringSubmatch(match)
		if len(parts) < 2 {
			return match
		}
		return os.Getenv(parts[1])
	})

	// Resolve tenant secrets from K8s Secret data.
	result = tenantSecretRe.ReplaceAllStringFunc(result, func(match string) string {
		parts := tenantSecretRe.FindStringSubmatch(match)
		if len(parts) < 2 {
			return match
		}
		if tenantSecretData == nil {
			return match
		}
		if v, ok := tenantSecretData[parts[1]]; ok {
			return string(v)
		}
		return match
	})

	// Resolve ${secret:[NAMESPACE/]NAME:KEY}. All referenced secrets/keys are
	// pre-validated by prefetchSecrets, so any miss here is a logic bug.
	result = secretRe.ReplaceAllStringFunc(result, func(match string) string {
		parts := secretRe.FindStringSubmatch(match)
		ns := parts[1]
		if ns == "" {
			ns = operatorNs
		}
		data, ok := secretCache[ns+"/"+parts[2]]
		if !ok {
			return match
		}
		if v, ok := data[parts[3]]; ok {
			return string(v)
		}
		return match
	})

	return result, nil
}
```

- [ ] **Step 4: Run the new tests — expect pass.**

```bash
cd /Users/z/work/boilerhouse/go
go test ./internal/operator/ -run 'TestResolveCredentials_SecretSyntax|TestResolveCredentials_CombinedTenantAndSecret' -count=1 -v
```

Expected: all five new tests PASS.

- [ ] **Step 5: Run the full operator package to ensure nothing else regressed.**

```bash
cd /Users/z/work/boilerhouse/go
export KUBEBUILDER_ASSETS="$("$(go env GOPATH)/bin/setup-envtest" use -p path)"
go test ./internal/operator/ -count=1 -timeout 180s
```

Expected: PASS. Existing `TestResolveCredentials_GlobalSecret`, `TestResolveCredentials_TenantSecret`, `TestResolveCredentials_MixedSecrets`, `TestResolveCredentials_SkipsEmptyDomain` should all still pass.

- [ ] **Step 6: Commit.**

```bash
cd /Users/z/work/boilerhouse
git add go/internal/operator/sidecar.go go/internal/operator/sidecar_test.go
git commit -m "feat(operator): add \${secret:[NAMESPACE/]NAME:KEY} credential syntax"
```

---

## Task 2: Remove `${global-secret:...}` syntax

The old env-var-backed syntax is now strictly subsumed by `${secret:...}`. Delete the regex, the resolver branch, and the two tests that exercise it.

**Files:**
- Modify: `go/internal/operator/sidecar.go`
- Modify: `go/internal/operator/sidecar_test.go`

- [ ] **Step 1: Re-verify no committed YAML uses `${global-secret:...}`.**

```bash
cd /Users/z/work/boilerhouse
grep -rE '\$\{global-secret:' --include='*.yaml' --include='*.yml' .
```

Expected: empty. If anything matches, stop — there's a migration task that isn't in this plan.

- [ ] **Step 2: Delete the regex.**

In `go/internal/operator/sidecar.go`, remove the `globalSecretRe` line from the var block. After the edit, the block reads:

```go
var (
	tenantSecretRe = regexp.MustCompile(`\$\{tenant-secret:([^}]+)\}`)
	secretRe       = regexp.MustCompile(`\$\{secret:(?:([^/}:]+)/)?([^:}]+):([^}]+)\}`)
)
```

- [ ] **Step 3: Delete the global-secret branch from `resolveValue`.**

In `go/internal/operator/sidecar.go`, in `resolveValue`, remove the first `ReplaceAllStringFunc` block (the one using `globalSecretRe` and `os.Getenv`). Start with `val` directly in the second call:

```go
func resolveValue(val string, tenantSecretData map[string][]byte, secretCache map[string]map[string][]byte, operatorNs string) (string, error) {
	// Resolve tenant secrets from K8s Secret data.
	result := tenantSecretRe.ReplaceAllStringFunc(val, func(match string) string {
		parts := tenantSecretRe.FindStringSubmatch(match)
		if len(parts) < 2 {
			return match
		}
		if tenantSecretData == nil {
			return match
		}
		if v, ok := tenantSecretData[parts[1]]; ok {
			return string(v)
		}
		return match
	})

	// Resolve ${secret:[NAMESPACE/]NAME:KEY}. All referenced secrets/keys are
	// pre-validated by prefetchSecrets, so any miss here is a logic bug.
	result = secretRe.ReplaceAllStringFunc(result, func(match string) string {
		parts := secretRe.FindStringSubmatch(match)
		ns := parts[1]
		if ns == "" {
			ns = operatorNs
		}
		data, ok := secretCache[ns+"/"+parts[2]]
		if !ok {
			return match
		}
		if v, ok := data[parts[3]]; ok {
			return string(v)
		}
		return match
	})

	return result, nil
}
```

- [ ] **Step 4: Update the function doc comment.**

In `ResolveCredentials`'s doc comment, remove the `${global-secret:NAME}` line. Final comment:

```go
// ResolveCredentials resolves secret references in workload credential headers.
// ${tenant-secret:NAME} is resolved from a K8s Secret named "bh-secret-<tenantId>".
// ${secret:[NAMESPACE/]NAME:KEY} is resolved from an arbitrary K8s Secret
// (namespace defaults to the operator's namespace).
```

- [ ] **Step 5: Remove the `os` import from `sidecar.go` if no other usage remains.**

```bash
cd /Users/z/work/boilerhouse/go
grep -n '\bos\.' internal/operator/sidecar.go
```

If the only hit was inside the deleted branch, delete `"os"` from the import block in `sidecar.go`.

- [ ] **Step 6: Delete the obsolete tests.**

In `go/internal/operator/sidecar_test.go`:

- Delete `TestResolveCredentials_GlobalSecret` (lines ~105-129).
- Delete `TestResolveCredentials_MixedSecrets` (lines ~168-208). Its coverage is now provided by `TestResolveCredentials_CombinedTenantAndSecret`.

Also remove `"os"` from the test file's import block if nothing else in the file uses it:

```bash
grep -n '\bos\.' internal/operator/sidecar_test.go
```

- [ ] **Step 7: Run the full operator package.**

```bash
cd /Users/z/work/boilerhouse/go
export KUBEBUILDER_ASSETS="$("$(go env GOPATH)/bin/setup-envtest" use -p path)"
go test ./internal/operator/ -count=1 -timeout 180s
```

Expected: PASS. Tests remaining: `TestInjectSidecar`, `TestResolveCredentials_TenantSecret`, `TestResolveCredentials_SkipsEmptyDomain`, plus the five new tests from Task 1.

- [ ] **Step 8: Run the whole module to catch downstream breakage.**

```bash
cd /Users/z/work/boilerhouse/go
go build ./...
go vet ./...
export KUBEBUILDER_ASSETS="$("$(go env GOPATH)/bin/setup-envtest" use -p path)"
go test ./... -count=1 -timeout 300s
```

Expected: PASS. If anything else in the codebase was referencing the deleted `globalSecretRe`, this will surface it.

- [ ] **Step 9: Commit.**

```bash
cd /Users/z/work/boilerhouse
git add go/internal/operator/sidecar.go go/internal/operator/sidecar_test.go
git commit -m "feat(operator): remove \${global-secret:...} syntax"
```

---

## Task 3: Document cross-namespace RBAC escape hatch

Default operator RBAC is scoped to its own namespace. Users who want `${secret:other-ns/...}` need to add a RoleBinding in the target namespace. Document this next to the credential docs.

**Files:**
- Locate: the credential/workload docs file.
- Create or modify: one doc file.

- [ ] **Step 1: Locate the credential docs.**

```bash
cd /Users/z/work/boilerhouse
grep -rln 'tenant-secret\|credentials:\|NetworkCredential' docs/ --include='*.md' 2>/dev/null
grep -rln 'tenant-secret' README.md 2>/dev/null
```

If a workload reference doc exists (e.g. `docs/workloads.md` or similar), extend it. If no existing home fits, create `docs/credential-injection.md`.

- [ ] **Step 2: Write the doc section.**

Use the content below. If extending an existing doc, append as a new section; if creating a new file, use it as the whole file.

```markdown
## Credential Injection

Workload `network.credentials[].headers` values support reference substitution:

| Syntax | Resolved from |
|---|---|
| `${tenant-secret:KEY}` | K8s Secret `bh-secret-<tenantId>` in the operator's namespace, key `KEY`. |
| `${secret:NAME:KEY}` | K8s Secret `NAME` in the operator's namespace, key `KEY`. |
| `${secret:NAMESPACE/NAME:KEY}` | K8s Secret `NAME` in `NAMESPACE`, key `KEY`. |

Values are resolved at pod creation. Rotating a referenced Secret does not restart existing pods — delete and recreate the Claim (or rely on natural idle teardown) to pick up new values.

### Cross-namespace secrets

The operator ships with RBAC scoped to its own namespace. To allow `${secret:OTHER-NS/...}`, install a RoleBinding in the target namespace:

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

Without this RoleBinding, cross-namespace references fail at pod creation with an RBAC error naming the target Secret.
```

- [ ] **Step 3: Commit.**

```bash
cd /Users/z/work/boilerhouse
git add <doc-file-path>
git commit -m "docs: credential injection syntax + cross-namespace RBAC"
```

---

## Self-Review Notes

After all tasks complete:

- **Regex stays identical** across Task 1 (definition) and any test that relies on the parse shape. Namespace capture group is `[^/}:]+`, name is `[^:}]+`, key is `[^}]+`.
- **Default namespace** substitution happens in exactly two places: `prefetchSecrets` and `resolveValue`. Both must fall back to `operatorNs` when the capture is empty. Mismatch here would cause tests to pass individually but fail when the syntax is used without an explicit namespace — run the `TestResolveCredentials_SecretSyntax_DefaultNamespace` case explicitly after any edit.
- **Only `go/internal/operator/sidecar.go` gets the new resolver logic.** No changes to Envoy generation, workload YAML schema, or CRD types.
- **Cross-namespace RBAC docs are for users, not for code.** No operator RBAC manifest change in `config/deploy/operator.yaml`.
