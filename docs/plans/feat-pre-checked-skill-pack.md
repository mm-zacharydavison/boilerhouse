# Pre-Checked Skill Pack (Go/K8s)

**Goal:** Ship a curated set of productivity workloads (Google Calendar, Gmail, reminders/todo, web search, weather) so a fresh Boilerhouse install is useful out of the box.

**Architecture:** Skill-pack workloads are `BoilerhouseWorkload` YAML manifests under `config/skill-pack/`. They are applied to the cluster via kustomize (a kadai action `setup-skill-pack`) at install time and on upgrades. Each workload pulls its required env from a shared K8s Secret; if the Secret key is missing, the WorkloadController surfaces it via `status.phase=Error, status.detail="missing secret X"`. A `/api/v1/skill-pack/status` endpoint reads those statuses and returns a dashboard-friendly view.

There is no "first run" detection — kustomize is idempotent. There is no DB. There is no per-workload installer; the operator's existing reconciler handles workload health.

---

## Codebase Orientation

- Workloads are `BoilerhouseWorkload` CRs (`go/api/v1alpha1/workload_types.go`). The translator (`translator.go`) materializes them into Pods. The workload controller (`workload_controller.go`) reconciles.
- Secrets for env-var injection follow the `SecretKeyRef` pattern already on `WorkloadNetwork.Credentials` (`workload_types.go:38-49`). The same pattern applies to entrypoint env (extend `WorkloadEntrypoint` if needed).
- The Go API has a `routes_system.go`. New skill-pack endpoints live there or in a new `routes_skill_pack.go`.

---

## File Map

```
config/skill-pack/
  kustomization.yaml                kustomize entry point
  manifest.yaml                     ConfigMap describing the pack (id → label, required keys)
  google-calendar.workload.yaml
  gmail.workload.yaml
  reminders.workload.yaml
  web-search.workload.yaml
  weather.workload.yaml
  README.md                         operator setup guide

config/skill-pack/secret.example.env   template for skill-pack-secrets

go/internal/api/routes_skill_pack.go   GET /skill-pack/status endpoint
go/internal/api/routes_skill_pack_test.go

go/internal/api/skill_pack_manifest.go  Go struct mirror of manifest.yaml (loaded at API startup from a ConfigMap)

.kadai/skill-pack.yaml                 new kadai action: setup-skill-pack
```

---

## Task 1: Skill Pack Manifest (ConfigMap)

`config/skill-pack/manifest.yaml`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: boilerhouse-skill-pack-manifest
  namespace: boilerhouse
data:
  skills.yaml: |
    - id: skill-google-calendar
      label: Google Calendar
      workloadName: skill-google-calendar
      requiredSecretKeys: [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET]
      optionalSecretKeys: [GOOGLE_CALENDAR_ID]
    - id: skill-gmail
      label: Gmail
      workloadName: skill-gmail
      requiredSecretKeys: [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET]
    - id: skill-reminders
      label: Reminders & Todo
      workloadName: skill-reminders
      requiredSecretKeys: []
    - id: skill-web-search
      label: Web Search
      workloadName: skill-web-search
      requiredSecretKeys: [BRAVE_SEARCH_API_KEY]
    - id: skill-weather
      label: Weather
      workloadName: skill-weather
      requiredSecretKeys: [OPENWEATHER_API_KEY]
```

The API server loads this ConfigMap at startup (and on update via informer). It is the source of truth for skill metadata. This avoids hard-coding the manifest in Go and lets operators add their own skills without recompiling.

---

## Task 2: Skill Workload Manifests

Each `*.workload.yaml` is a `BoilerhouseWorkload` CR. Example for web-search:

```yaml
apiVersion: boilerhouse.io/v1alpha1
kind: BoilerhouseWorkload
metadata:
  name: skill-web-search
  namespace: boilerhouse
spec:
  version: "1.0.0"
  image:
    ref: ghcr.io/boilerhouse/skill-web-search:latest
  resources: { vcpus: 1, memoryMb: 512, diskGb: 1 }
  network:
    access: restricted
    expose: [{ guest: 8080 }]
    allowlist: [api.search.brave.com]
  health:
    httpGet: { path: /health, port: 8080 }
    intervalSeconds: 10
  idle: { timeoutSeconds: 300, action: hibernate }
  entrypoint:
    env:
      BRAVE_SEARCH_API_KEY:
        valueFrom:
          secretKeyRef: { name: boilerhouse-skill-pack-secrets, key: BRAVE_SEARCH_API_KEY }
```

Image refs are placeholders; the workload will sit in `phase=Error` with `detail="image pull failed"` until real skill images are published — visible via `/skill-pack/status`.

**Schema note:** `WorkloadEntrypoint.Env` is currently `*runtime.RawExtension`. Either keep the raw map and let the translator pass through `valueFrom` blobs, or formalize a typed `EnvVar` struct mirroring `corev1.EnvVar`. Recommend the typed approach — it's more discoverable and lets the controller validate at admission. Track as a separate small CRD-shape change if not already done.

---

## Task 3: kustomization.yaml + kadai action

`config/skill-pack/kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: boilerhouse
resources:
  - manifest.yaml
  - google-calendar.workload.yaml
  - gmail.workload.yaml
  - reminders.workload.yaml
  - web-search.workload.yaml
  - weather.workload.yaml
```

Operators provision the secret separately (template in `secret.example.env`):

```sh
kubectl create secret generic boilerhouse-skill-pack-secrets \
  --namespace boilerhouse \
  --from-env-file=skill-pack-secrets.env
```

`.kadai/skill-pack.yaml` action:

```yaml
- id: setup-skill-pack
  shell: |
    kubectl apply -k config/skill-pack/
    echo "Skill pack applied. Check status: bunx kadai run skill-pack-status"
- id: skill-pack-status
  shell: |
    curl -s http://localhost:3000/api/v1/skill-pack/status | jq
```

---

## Task 4: `GET /api/v1/skill-pack/status` endpoint

`go/internal/api/routes_skill_pack.go`:

```go
type SkillStatus struct {
    ID                 string   `json:"id"`
    Label              string   `json:"label"`
    Installed          bool     `json:"installed"`
    WorkloadName       string   `json:"workloadName"`
    Phase              string   `json:"phase"`              // empty if not installed
    Detail             string   `json:"detail,omitempty"`
    MissingSecretKeys  []string `json:"missingSecretKeys,omitempty"`
}

func (s *Server) getSkillPackStatus(w http.ResponseWriter, r *http.Request) {
    manifest, err := s.skillPackManifest.Get(r.Context())
    if err != nil { writeError(w, 500, err.Error()); return }

    secret, _ := s.getSkillPackSecret(r.Context()) // may be nil

    out := make([]SkillStatus, 0, len(manifest))
    for _, entry := range manifest {
        var wl v1alpha1.BoilerhouseWorkload
        err := s.client.Get(r.Context(), client.ObjectKey{Namespace: s.namespace, Name: entry.WorkloadName}, &wl)
        installed := err == nil
        missing := missingKeys(secret, entry.RequiredSecretKeys)

        st := SkillStatus{ID: entry.ID, Label: entry.Label, Installed: installed, WorkloadName: entry.WorkloadName, MissingSecretKeys: missing}
        if installed {
            st.Phase = wl.Status.Phase
            st.Detail = wl.Status.Detail
        }
        out = append(out, st)
    }
    writeJSON(w, 200, map[string]any{"skills": out})
}
```

Mount in `server.go:buildRouter`:

```go
r.Get("/skill-pack/status", s.getSkillPackStatus) // inside auth group
```

### Tests

`routes_skill_pack_test.go` (envtest + httptest):

- Manifest ConfigMap missing → 500 with clear message.
- Manifest present, no workloads installed → array with `installed=false` for each.
- Manifest present, workload installed but secret missing required key → `phase=...`, `missingSecretKeys=["FOO"]`.
- All workloads installed and Ready → all entries `phase=Ready`, missing empty.

---

## Task 5: Manifest Loader

`go/internal/api/skill_pack_manifest.go`:

```go
type SkillPackEntry struct {
    ID                  string   `yaml:"id"`
    Label               string   `yaml:"label"`
    WorkloadName        string   `yaml:"workloadName"`
    RequiredSecretKeys  []string `yaml:"requiredSecretKeys"`
    OptionalSecretKeys  []string `yaml:"optionalSecretKeys,omitempty"`
}

type SkillPackManifest struct {
    client    client.Client
    namespace string
    cache     atomic.Pointer[[]SkillPackEntry]
}

func (m *SkillPackManifest) Get(ctx context.Context) ([]SkillPackEntry, error) {
    if v := m.cache.Load(); v != nil {
        return *v, nil
    }
    return m.load(ctx)
}
```

Backed by the standard controller-runtime client (cache-backed Get). The atomic.Pointer is just a hot-path skip; informer events flush it.

---

## Task 6: README Setup Guide

`config/skill-pack/README.md` covers:

- One-line install: `bunx kadai run setup-skill-pack`
- Per-skill setup (Google Cloud OAuth, Brave signup, OpenWeatherMap signup) — copy-paste from old plan, the external setup steps haven't changed.
- Provisioning the Secret: `kubectl create secret ...`
- Checking status: `bunx kadai run skill-pack-status`
- Adding a custom skill: drop a `BoilerhouseWorkload` YAML into a custom kustomize overlay, append it to manifest ConfigMap.
- OAuth token lifecycle: each skill image is responsible for refreshing its own token via the configured client credentials. Skills should mount a writable Secret to persist refresh tokens (covered in skill image docs, not here).

---

## Task 7: Integrate Into Default Deploy

`config/deploy/kustomization.yaml` already kustomize-builds the operator + API. **Do not** auto-include skill-pack — operators opt in by running the action. Reasoning: pulling 5 placeholder images on first install sticks the cluster in pull-back-off and is bad first-run UX.

Document the action in `README.md`'s Quickstart.

---

## Configuration: Required Secret Keys

| Skill | Key | Where to get it |
|-------|-----|-----------------|
| Google Calendar | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | console.cloud.google.com → OAuth 2.0 credentials |
| Gmail | Same | + enable Gmail API |
| Web Search | `BRAVE_SEARCH_API_KEY` | api.search.brave.com (2000/mo free) |
| Weather | `OPENWEATHER_API_KEY` | openweathermap.org/api (free tier) |
| Reminders | None | No external creds |

All keys live in `boilerhouse-skill-pack-secrets`.

---

## Sequencing

1. CRD audit: confirm `WorkloadEntrypoint.Env` accepts `valueFrom: secretKeyRef`. If not, formalize EnvVar typing and regenerate manifests. (May already be in `runtime.RawExtension` and "just work".)
2. `manifest.yaml` ConfigMap + manifest loader in Go.
3. Five `*.workload.yaml` files + `kustomization.yaml`.
4. kadai actions.
5. `/skill-pack/status` route + tests.
6. README.

Items 2-4 can be done in parallel. Item 5 depends on 2.

---

## Risk Notes

- **Skill images not yet published:** Workloads will sit in `phase=Error` until real images are pushed. The status endpoint reflects this honestly — not a blocker.
- **OAuth token lifecycle:** Each skill image owns its refresh logic. Out of scope for this plan; document expectation in README.
- **No first-run race:** kustomize apply is idempotent. Multiple operators applying simultaneously is safe (K8s API resolves conflicts via resourceVersion).
- **Secret missing at install:** Workload Pods will fail to start (env from secretKeyRef → kubelet error). The workload controller should surface this as `phase=Error, detail="secret key BRAVE_SEARCH_API_KEY missing"`. Verify the controller reads kubelet events, otherwise add explicit Pod-status interpretation.
- **Manifest drift:** If an operator hand-deletes a skill workload but leaves the manifest entry, status shows `installed=false` — matches reality. If they add a workload with the same name but skip the manifest entry, it doesn't show up — also acceptable; that workload is just a regular workload.

---

## What changed from the TS-era plan

- No SQLite, no `isFirstRun`, no `installSkillPack` function — kustomize replaces all of it.
- No CLI command (`api install`) to embed env stubs — operators use `kubectl create secret` from a documented template.
- No `WORKLOADS_DIR` / `WorkloadWatcher` — the operator watches CRDs natively via informers.
- No `SKILL_PACK_DIR` env var — the manifest is a ConfigMap inside the cluster.
- No `apps/dashboard` changes — the dashboard already reads workload status from the API; the new `/skill-pack/status` endpoint just adds a richer view.
