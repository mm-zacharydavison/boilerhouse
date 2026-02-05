# Secure Production Deployment

## Problem

Boilerhouse manages Docker containers on behalf of tenants. It needs access to the Docker daemon, which means mounting `/var/run/docker.sock`. Anyone with access to that socket has effective root on the host. We need to:

1. Limit what Docker API calls Boilerhouse can make (even if the container is compromised)
2. Prevent unauthorized access to Boilerhouse's own API
3. Make the secure deployment the default — `docker compose up` should just work

## Architecture

```
┌─── host ──────────────────────────────────────────────┐
│                                                       │
│  ┌─ public network ──────┐                            │
│  │   your-app :443       │                            │
│  └──────────┬────────────┘                            │
│             │                                         │
│  ┌─ boilerhouse network (internal) ──┐                │
│  │   boilerhouse :3000               │                │
│  │   (no published ports)            │                │
│  └──────────┬────────────────────────┘                │
│             │                                         │
│  ┌─ docker-socket network (internal) ┐                │
│  │   docker-proxy :2375              │                │
│  └──────────┬────────────────────────┘                │
│             │                                         │
│    /var/run/docker.sock                               │
│                                                       │
│    managed containers (siblings on host)               │
└───────────────────────────────────────────────────────┘
```

### Why docker-socket-proxy?

The Docker socket gives full root-equivalent access to the host. Even with TypeScript interfaces restricting what Boilerhouse's own code does, a compromised container could talk to the socket directly (`curl --unix-socket ...`). The proxy is a separate process that filters Docker API calls at the HTTP level — it's the only way to truly limit access from a compromised container.

The proxy (tecnativa/docker-socket-proxy) is ~5MB, zero-config, and we include it in the compose file so users get it automatically.

### Allowed Docker API endpoints

| Endpoint   | Allowed | Why                                        |
|------------|---------|-------------------------------------------|
| CONTAINERS | Yes     | Create, start, stop, remove, inspect, list |
| IMAGES     | Yes     | Pull images for workloads                  |
| POST       | Yes     | Write operations (create, start, stop)     |
| EXEC       | No      | Not needed, would allow shell into tenants |
| NETWORKS   | No      | Boilerhouse uses default bridge network    |
| VOLUMES    | No      | Uses bind mounts, not Docker volumes       |
| SWARM      | No      | Single-node only                           |
| NODES      | No      | Single-node only                           |
| SERVICES   | No      | Not using Docker services                  |

## Security layers

### Layer 1: Network isolation
- Boilerhouse has **no published ports**
- Only containers on the `boilerhouse` network can reach its API
- The docker-proxy is on a separate internal network — only Boilerhouse can reach it
- Your app joins the `boilerhouse` network to communicate

### Layer 2: Docker socket proxy
- Whitelists only CONTAINERS and IMAGES endpoints
- Blocks exec, network manipulation, volume creation, swarm operations
- Even if Boilerhouse is fully compromised, attacker can only create/destroy containers

### Layer 3: API key authentication
- `BOILERHOUSE_API_KEY` env var — when set, all endpoints except `/api/v1/health` require `Authorization: Bearer <key>`
- Shared between Boilerhouse and the companion app via env var
- Health endpoint stays public for Docker health checks and load balancers

### Layer 4: Container hardening
- `read_only: true` — filesystem is read-only (tmpfs for /tmp and rclone cache)
- Non-root user (`bun` user from oven/bun image)
- Minimal Alpine image with no shell utilities beyond what's needed
- Resource limits prevent DoS

## Implementation

### Files to create

#### `Dockerfile` (production, multi-stage)
- Stage 1 (`deps`): Copy all workspace package.json files, `bun install --frozen-lockfile`
- Stage 2 (`build`): Copy source, `bun run build` (produces `apps/api/dist/index.js`)
- Stage 3 (`production`): `oven/bun:1-alpine`, install `rclone` + `curl` (for healthcheck), copy built output
- Set `NODE_ENV=production`, expose 3000
- Healthcheck: `curl -f http://localhost:3000/api/v1/health`

#### `deploy/docker-compose.yml`
```yaml
services:
  docker-proxy:
    image: tecnativa/docker-socket-proxy:latest
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    environment:
      CONTAINERS: 1
      IMAGES: 1
      POST: 1
    networks:
      - docker-socket
    restart: unless-stopped

  boilerhouse:
    build: ..
    environment:
      DOCKER_HOST: tcp://docker-proxy:2375
      BOILERHOUSE_API_KEY: ${BOILERHOUSE_API_KEY:?Set BOILERHOUSE_API_KEY}
      BOILERHOUSE_STATE_DIR: /var/lib/boilerhouse/states
      BOILERHOUSE_SECRETS_DIR: /var/lib/boilerhouse/secrets
      BOILERHOUSE_SOCKET_DIR: /var/run/boilerhouse
      BOILERHOUSE_DB_PATH: /data/boilerhouse.db
      BOILERHOUSE_WORKLOADS_DIR: /etc/boilerhouse/workloads
      NODE_ENV: production
    volumes:
      - boilerhouse-data:/data
      - /var/lib/boilerhouse/states:/var/lib/boilerhouse/states
      - /var/lib/boilerhouse/secrets:/var/lib/boilerhouse/secrets
      - /var/run/boilerhouse:/var/run/boilerhouse
      - ./workloads:/etc/boilerhouse/workloads:ro
    networks:
      - docker-socket
      - boilerhouse
    depends_on:
      - docker-proxy
    restart: unless-stopped
    read_only: true
    tmpfs:
      - /tmp
      - /home/bun/.cache
    # NO ports: section — not reachable from host network

  # Example: your application
  # your-app:
  #   image: your-app:latest
  #   environment:
  #     BOILERHOUSE_URL: http://boilerhouse:3000
  #     BOILERHOUSE_API_KEY: ${BOILERHOUSE_API_KEY}
  #   networks:
  #     - boilerhouse
  #     - public
  #   ports:
  #     - "443:443"

networks:
  docker-socket:
    internal: true   # no external access
  boilerhouse:
    internal: true   # no external access
  # public:          # uncomment for your app

volumes:
  boilerhouse-data:
```

#### `deploy/.env.example`
Documented template with all env vars, defaults, and explanations.

### Files to modify

#### `apps/api/lib/config.ts`
Add `apiKey` field:
```typescript
apiKey: getEnvString('BOILERHOUSE_API_KEY', ''),
```

#### `apps/api/src/index.ts`
- Parse `DOCKER_HOST` env var into `DockerRuntimeConfig`:
  - `tcp://host:port` → `{ host, port }`
  - `unix:///path` → `{ socketPath }`
  - unset → `undefined` (default socket `/var/run/docker.sock`)
- Pass to `new DockerRuntime(parsedConfig)`
- Pass `config.apiKey` to `createServer()`
- Log Docker connection target

#### `apps/api/src/server.ts`
- Add `apiKey?: string` to `ServerDependencies`
- When `apiKey` is set, add `.onBeforeHandle()` after health controller:
  - Skip auth for paths starting with `/api/v1/health`
  - Check `Authorization: Bearer <key>` header
  - Return 401 `{ error: 'Unauthorized' }` on mismatch
- When `apiKey` is empty/unset, no auth enforced (backwards compatible for dev)

## Verification

- `bun run typecheck` — passes
- `bun test` — passes (no API key in tests = no auth = backwards compatible)
- `docker build .` — succeeds
- Manual test with API key:
  ```bash
  BOILERHOUSE_API_KEY=test bun run dev:api
  curl localhost:3000/api/v1/health           # → 200
  curl localhost:3000/api/v1/pools            # → 401
  curl -H "Authorization: Bearer test" localhost:3000/api/v1/pools  # → 200
  ```
- Full deployment test: `cd deploy && docker compose up`
