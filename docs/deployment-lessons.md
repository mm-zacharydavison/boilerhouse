# Deployment Lessons

Findings worth carrying forward into the Go/K8s deployment story. Most TS-era / Docker-Compose lessons no longer apply — the K8s topology (PVCs, Service DNS, Ingress, kustomize) makes those classes of bug impossible to hit. What remains is captured below in two sections: lessons that apply *today*, and warnings for subsystems that haven't been ported yet but whose original implementations had known gotchas.

For the obsolete TS/Compose-era lessons that this doc replaces, see `git log -- docs/deployment-lessons.md`.

---

## Applies Today

### Credential injection requires `restricted` network mode

`network.credentials` only works when the workload's egress goes through the envoy MITM sidecar. With `access: "unrestricted"` the traffic bypasses envoy entirely and credentials are never injected.

For unrestricted egress *with* credential injection, set `access: "restricted"` and use a permissive allowlist:

```yaml
network:
  access: restricted
  allowlist: ["api.anthropic.com", "*"]
  credentials:
    - domain: api.anthropic.com
      secretRef: { name: anthropic-creds, key: token }
```

(The `*` wildcard handling itself is currently a known gap in the Go envoy config — see "Future warnings" below.)

### Workload health check endpoints

Workload images must expose a real health endpoint. The default OpenClaw path `/__openclaw/control-ui-config.json` returns 404 when the control UI is disabled — use `/health` instead:

```yaml
health:
  httpGet: { path: /health, port: 8080 }
```

This is enforced at the workload spec level (`BoilerhouseWorkloadSpec.Health.HTTPGet`), but operators authoring custom workloads still hit the wrong path because copy-paste from older examples persists.

### Documentation gaps

Examples that are still missing in the Go docs:

- Multi-tenant access control via `Trigger.Guards`
- Allowlist guard with custom deny messages
- Telegram polling vs webhook trade-offs (the Go adapter only does long-polling; webhook mode isn't ported)
- Trigger → workload driver configuration (the `driver` field on `BoilerhouseTriggerSpec`)

These belong in `docs/` as small focused recipes rather than reference dumps. Treat as a docs-improvement TODO.

---

## Future Warnings (subsystems not yet ported)

These are gotchas the TS implementation already learned about. When the corresponding Go subsystem is built, save the rediscovery cost.

### When envoy `*` wildcard support is added

The TS envoy config originally crashed when an allowlist contained a bare `*` because:

1. Bare `*` rendered as a YAML alias in the generated config (envoy parser failure).
2. `*` produced invalid cluster configs (`address: *`, `sni: *`).
3. `*` requires the `ORIGINAL_DST` cluster + `envoy.filters.listener.original_dst` listener filter — without the listener filter, iptables-redirected traffic fails with `No downstream connection or no original_dst`.

The Go envoy config (`go/internal/envoy/config.go`) currently only generates explicit per-domain clusters from `network.allowlist` and supports the `none/restricted/unrestricted` modes. When/if `*`-style passthrough is added, port the three fixes together:

- Filter `*` from per-domain processing; auto-add credential domains so they still get MITM + header injection.
- Use `ORIGINAL_DST` cluster for the catch-all.
- Add `envoy.filters.listener.original_dst` to both HTTP and TLS listeners in the bootstrap template.

### When tenant-data encryption (`BOILERHOUSE_SECRET_KEY`) is ported

The TS implementation used a 32-byte hex key for AES-256-GCM encryption of tenant secrets. No equivalent in Go yet (`grep` returns no references). When porting:

- Generate via `openssl rand -hex 32`. Document this prominently in the install guide — operators who skip it get cryptic errors at first secret write.
- Store as a K8s Secret named `boilerhouse-secret-key` mounted into the API and operator pods, not as a literal env var in deployment YAML.
- Treat the key as immutable: rotation needs a re-encryption pass over every existing tenant secret.

### When S3 snapshot storage is ported

`SnapshotManager` in the Go operator currently stores snapshots locally. When S3 backend support lands:

- The bucket must exist before the API/operator starts. `NoSuchBucket` during hibernate previously left tenants stuck — `refactor-go-resilience.md` R1 already covers the "don't delete the Pod on extraction failure" behavior, which makes this less catastrophic, but the bucket-not-found failure mode itself is still worth surfacing as a startup health check.
- Hetzner Object Storage uses region-specific endpoints (`nbg1.your-objectstorage.com`, `fsn1.your-objectstorage.com`, etc.) — the endpoint must match the bucket's region. AWS/MinIO/etc. have analogous regional concerns.
- Validate S3 connectivity at operator startup and surface failures via Operator Pod readiness, not at first hibernate.

---

## Production deployment

The TS-era `oddjob.ooo` deployment used SSH + Docker Compose + Caddy + a hand-rolled deploy script. None of that applies on K8s.

The current production model is `config/deploy/` kustomize manifests applied via `kubectl apply -k`. A future GitOps story (Argo CD or Flux watching `config/deploy/`) is the natural next step but isn't implemented yet — track separately if it becomes a blocker.

For local cleanup/reset, `bunx kadai run nuke` removes all Boilerhouse resources from the cluster (per CLAUDE.md). No script changes needed.
