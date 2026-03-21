# Deployment Readiness Checklist

Boilerhouse is an infrastructure component consumed by other applications.
This tracks what's needed for consumers to deploy it.

## Ready

- [x] **Dockerfile** — builds the API image (`oven/bun:1-alpine` based)
- [x] **Systemd units** — `deploy/boilerhouse-podmand.service`, `deploy/boilerhouse-api.service`
- [x] **Host install script** — `deploy/install.sh` (installs deps, podmand, generates secrets)
- [x] **Reverse proxy config** — `deploy/Caddyfile` (Caddy, auto-TLS, auth, rate limiting)
- [x] **Firewall rules** — `deploy/nftables.conf`
- [x] **Observability** — Prometheus scrape config + Grafana dashboard
- [x] **Deployment guides** — `docs/deploy-vm.md`, `docs/deploy-kubernetes.md`
- [x] **docker-compose snippet** — documented in deploy-vm.md for consumers to copy
- [x] **Security hardening** — systemd sandboxing, socket permissions, encrypted secrets

## Still needed

### High priority

- [ ] **Binary releases** — single `boilerhouse` binary built via GitHub Actions CI,
  published to GitHub Releases. Should bundle both the API and podmand. Subcommands:
  - `boilerhouse host install` — runs the host setup (what `deploy/install.sh` does now)
  - `boilerhouse api start` — runs the API server
  - `boilerhouse api install` — installs the API as a systemd service
  - `boilerhouse podmand start` — runs podmand (used by the systemd service)
  This is the recommended non-Docker way of running boilerhouse.

- [ ] **Published container image** — publish to ghcr.io via CI so consumers
  don't need to build the Docker image themselves.

- [ ] **Database migrations** — `initDatabase()` creates tables on first run,
  but schema changes over time need a migration strategy. Drizzle Kit can
  generate migrations; should run on startup.

- [ ] **Health check endpoint** — the API lacks a dedicated `/healthz` that
  verifies DB + runtime connectivity. Needed for compose healthchecks and
  K8s readiness probes. (podmand has `/healthz`; the API should too.)

### Medium priority

- [ ] **Backup documentation** — SQLite DB + snapshot archives need backups.
  Document recommended approach (e.g. `sqlite3 .backup` + rclone).

- [ ] **Secrets rotation** — document how to rotate `BOILERHOUSE_SECRET_KEY`
  without downtime (requires re-encrypting stored tenant secrets).

### Low priority

- [ ] **Helm chart** — for Kubernetes consumers who prefer Helm over raw manifests.

- [ ] **Multi-node** — the DB schema supports multiple nodes, but there's no
  orchestration for distributing tenants across nodes yet.

## Deployment model

**VM (recommended)**: Install the `boilerhouse` binary (or run from
source). `boilerhouse host install` sets up the host and starts podmand.
Then run the API either via the binary, as a systemd service, or as a
Docker container in your compose stack. See `docs/deploy-vm.md`.

**Kubernetes**: No podmand or host setup needed. The API runs as a
Deployment and creates tenant instances as K8s pods directly. No
CRIU/snapshots. See `docs/deploy-kubernetes.md`.
