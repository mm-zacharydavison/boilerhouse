# Dashboard

Boilerhouse ships with a small React dashboard for inspecting workloads, pools, triggers, and live instance events against the API server.

The dashboard is the one piece of the TypeScript implementation that is still in regular use post-migration. It lives at `ts/apps/dashboard/` in the repository.

## Running Locally

From the repository root, start the operator and API against minikube:

```bash
bunx kadai run dev
```

Then, in another terminal, start the dashboard:

```bash
cd ts
bun run dashboard
```

The dashboard is served on `http://localhost:3001` and proxies REST and WebSocket traffic to the API server on `http://localhost:3000`.

## What You Can See

| View | What it shows |
|------|---------------|
| Workloads | List of `BoilerhouseWorkload` CRs with phase and version |
| Workload detail | Spec, current instances, active claims, recent snapshots |
| Instance detail | Pod details, live logs, exec terminal |
| Triggers | `BoilerhouseTrigger` CRs with phase and type |
| Kubernetes | Raw namespace-scoped view (Pods, Services, PVCs, etc.) |

The dashboard connects to `/ws` for real-time updates — you see claim phase transitions, pool fills, and Pod lifecycle changes without refreshing.

## Building

Build a standalone binary with:

```bash
cd ts/apps/dashboard
bun run build   # single-binary server at dist/dashboard
```

Or target a specific Linux architecture:

```bash
bun run build:linux-amd64
bun run build:linux-arm64
```

The resulting binary serves the React bundle and proxies API calls. Deploy it in front of the API server using the same API auth configuration.

## Auth

The API server's Bearer-token auth (`BOILERHOUSE_API_KEY`) is enforced for all `/api/v1/*` routes. The dashboard server reads the key from its environment and forwards it to the API:

```bash
export BOILERHOUSE_API_KEY=your-api-key
bun run dashboard
```

The `/ws` endpoint is not protected by the API key, so the dashboard's WebSocket client connects without forwarding it.

## Future Direction

The dashboard remains in the TypeScript workspace for now. A Go or Go-embedded-asset rewrite is on the roadmap but not scheduled.
