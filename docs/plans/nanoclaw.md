# NanoClaw Integration

## Overview

Run NanoClaw as a boilerhouse workload to provide per-tenant AI assistants accessible via WhatsApp (and later other messaging platforms). Each tenant gets their own NanoClaw instance, with boilerhouse handling container pooling, state sync, and idle expiry.

## Why NanoClaw Over OpenClaw

| Factor             | OpenClaw                                     | NanoClaw                              |
| ------------------ | -------------------------------------------- | ------------------------------------- |
| Codebase           | 430K+ lines, 52 modules                      | ~500 lines core TS                    |
| Security           | App-level permissions (large attack surface)  | OS-level container isolation           |
| Messaging          | 13 platforms built-in (unused by us)          | WhatsApp only (we build our own)       |
| Container model    | Optional sandboxing, wants to own lifecycle   | Runs inside whatever container you give |
| Auditability       | Impractical to audit                          | Single developer can read entire codebase |

We don't use OpenClaw's messaging gateway (we're building our own multi-platform adapter). OpenClaw's gateway also fights boilerhouse on container lifecycle ownership. NanoClaw just runs inside a container and does its job.

## NanoClaw Architecture

NanoClaw is a personal AI assistant that connects to WhatsApp via Baileys and spawns ephemeral containers running the Claude Agent SDK for each interaction.

```
Host Process (Node.js)
├── WhatsApp connection (Baileys)
├── SQLite DB (messages, tasks, groups)
├── Polling loop (2s interval)
│   └── On trigger message:
│       ├── Set typing indicator
│       ├── Spawn ephemeral agent container
│       │   ├── Claude Agent SDK (query())
│       │   ├── MCP server for IPC (send_message, schedule_task)
│       │   └── Writes JSON to /workspace/ipc/
│       └── Process IPC output, send WhatsApp replies
├── IPC polling loop (1s interval)
│   └── Watches data/ipc/{folder}/ for JSON files
└── Task scheduler (cron-like scheduled tasks)
```

### Filesystem Layout

| Host Path                          | Container Mount         | Purpose                             |
| ---------------------------------- | ----------------------- | ----------------------------------- |
| `store/auth_info_baileys/`         | —                       | WhatsApp auth credentials           |
| `store/*.db`                       | —                       | SQLite (messages, chats, tasks)     |
| `data/sessions/{folder}/`          | `/home/node/.claude`    | Claude Agent SDK session state      |
| `data/ipc/{folder}/`              | `/workspace/ipc`        | Filesystem-based IPC                |
| `data/state.json`                  | —                       | Last processed message timestamp    |
| `data/registered_groups.json`      | —                       | Group registry                      |
| `groups/{name}/`                   | `/workspace/group`      | Per-group CLAUDE.md and archives    |

### Key Properties

- **Ephemeral agent containers** — spawned per-message, destroyed after response
- **Host process is long-running** — maintains WhatsApp connection and polling loops
- **Filesystem IPC** — no message queues, no sockets, just JSON files
- **Per-group isolation** — each WhatsApp group gets its own workspace and session

## Integration Strategy

### Pool the NanoClaw Host Process

Run the NanoClaw host process (the long-running Node.js process) as the boilerhouse workload. Each tenant gets their own NanoClaw instance with its own WhatsApp connection.

The NanoClaw host spawns its own ephemeral agent containers internally — these are short-lived (seconds to minutes) and managed by NanoClaw, not by boilerhouse.

```
┌── Boilerhouse ────────────────────────────────┐
│                                               │
│   Pool: "nanoclaw"                            │
│   ┌─ Container (tenant: alice) ─────────┐    │
│   │  NanoClaw host process               │    │
│   │  ├── WhatsApp (alice's account)      │    │
│   │  ├── SQLite, sessions, groups        │    │
│   │  └── Spawns agent containers ────────┼──► Docker API
│   └──────────────────────────────────────┘    │
│                                               │
│   ┌─ Container (tenant: bob) ───────────┐    │
│   │  NanoClaw host process               │    │
│   │  ├── WhatsApp (bob's account)        │    │
│   │  └── ...                             │    │
│   └──────────────────────────────────────┘    │
│                                               │
│   ┌─ Container (idle, pre-warmed) ──────┐    │
│   │  NanoClaw image ready                │    │
│   └──────────────────────────────────────┘    │
└───────────────────────────────────────────────┘
```

### Docker Access for Agent Containers

NanoClaw needs to spawn its own ephemeral containers. This requires Docker socket access from inside the boilerhouse-managed container.

Options:

| Approach                           | Security            | Complexity |
| ---------------------------------- | ------------------- | ---------- |
| Mount Docker socket                | Low (root escape)   | Simple     |
| Docker-in-Docker (DinD)            | Medium (isolated)   | Medium     |
| Docker socket proxy (filtered)     | High (allowlisted)  | Medium     |

**Recommendation:** Use the same `docker-socket-proxy` pattern from the [docker security plan](docker-security.md). NanoClaw only needs `CONTAINERS=1` and `IMAGES=1`. The proxy is already in our deployment stack.

Mount the proxy endpoint as an env var:

```yaml
environment:
  DOCKER_HOST: tcp://docker-proxy:2375
```

### Workload Spec

```yaml
id: nanoclaw
name: NanoClaw AI Assistant
image: nanoclaw:latest

command: ["node", "dist/index.js"]

environment:
  NODE_ENV: production
  ASSISTANT_NAME: Andy
  CONTAINER_IMAGE: nanoclaw-agent:latest
  DOCKER_HOST: tcp://docker-proxy:2375

volumes:
  state:
    target: /app/data
  secrets:
    target: /app/.env
    read_only: true
  comm:
    target: /app/store

security:
  user: 1000

resources:
  limits:
    cpus: 2
    memory: 2048

healthcheck:
  test: ["CMD", "node", "-e", "fetch('http://localhost:3847/health')"]
  interval: 30
  timeout: 5
  retries: 3
  start_period: 30

pool:
  min_size: 1
  max_size: 20
  file_idle_ttl_ms: 600000  # 10 min idle before release

sync:
  sink:
    type: s3
    bucket: boilerhouse-nanoclaw
    region: us-east-1

  mappings:
    # Claude Agent SDK sessions (conversation continuity)
    - path: data/sessions
      direction: bidirectional
      mode: sync

    # Per-group memory and conversation archives
    - path: groups
      direction: bidirectional
      mode: sync

    # Group registry and processing state
    - path: data/registered_groups.json
      direction: bidirectional
      mode: copy

    - path: data/state.json
      direction: bidirectional
      mode: copy

    # WhatsApp auth (session continuity)
    - path: store/auth_info_baileys
      direction: bidirectional
      mode: sync

    # SQLite DB (messages, chats, scheduled tasks)
    - path: store
      direction: upload
      mode: copy
      pattern: "*.db*"

  policy:
    on_claim: true
    on_release: true
    interval: 60000     # upload every 60s
    manual: true
```

### Claim/Release Lifecycle

| Event              | What Happens                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| **Claim**          | Sync downloads tenant's state (WhatsApp auth, sessions, groups, SQLite). NanoClaw starts, connects to WA.  |
| **Active**         | NanoClaw receives messages, spawns agent containers, processes IPC. Periodic sync uploads state.            |
| **Idle TTL fires** | No filesystem writes for `file_idle_ttl_ms`. Final sync upload. Container released back to pool.           |
| **Affinity hit**   | Tenant reclaims same container. WhatsApp session still alive. Zero cold-start latency.                     |
| **Affinity miss**  | Tenant gets fresh container. Full sync download. WhatsApp may need re-auth if session expired.             |

### Filesystem Idle TTL Integration

This workload is the primary use case for the [filesystem TTL expiry](filesystem-ttl-expiry.md) feature.

NanoClaw writes to its state directory (`data/`) whenever:
- A message is received and processed (`data/state.json` updated)
- An agent container runs and writes IPC files (`data/ipc/`)
- Sessions are updated (`data/sessions/`)
- Scheduled tasks execute

When the user stops chatting, these writes stop. The idle reaper detects the silence and triggers release.

## Challenges

### 1. WhatsApp Session Continuity

Baileys stores auth credentials that are tied to a session. If a container is released and the tenant reclaims later:

- **Affinity hit (same container):** session is still active, no re-auth needed
- **Affinity miss (different container):** state synced from S3, but session may have timed out server-side

**Mitigation:** Set `affinityTimeoutMs` high (30+ minutes) to maximise the chance of affinity hits. For cold starts after long absence, the user may need to re-scan a QR code.

### 2. SQLite Sync

Syncing a live SQLite database via rclone is fragile — the WAL file may be in an inconsistent state.

**Mitigation:**
- Use `mode: copy` (not `sync`) for `.db*` files — additive, doesn't delete
- Direction `upload` only — don't download a potentially stale DB over a live one
- On claim: NanoClaw starts fresh if no DB exists, or resumes from the synced copy
- Consider adding a pre-release hook that runs `sqlite3 .backup` before the sync upload

### 3. Agent Container Image Pre-Pull

The `nanoclaw-agent:latest` image is ~1GB+ (includes Chromium). If it's not pre-pulled on the host, the first agent invocation per host will be slow.

**Mitigation:** Pre-pull the agent image as part of the deployment. Add to docker-compose or a startup script:

```yaml
services:
  agent-image-pull:
    image: nanoclaw-agent:latest
    command: ["true"]
    deploy:
      restart_policy:
        condition: none
```

### 4. Network Access

NanoClaw needs outbound internet access for:
- WhatsApp Web API (Baileys WebSocket connection)
- Claude API (Anthropic)
- Web browsing (agent-browser / Chromium)

Boilerhouse's default bridge networking allows outbound. No special configuration needed unless firewall rules are restrictive.

### 5. IPC Directory Exclusion

NanoClaw's `data/ipc/` directory contains transient files consumed and deleted by the host process. These should not be synced.

The sync mappings above handle this by syncing specific paths (`data/sessions`, `data/registered_groups.json`, `data/state.json`) rather than the entire `data/` directory.

## Multi-Platform Messaging (Future)

NanoClaw currently supports WhatsApp only. To support Telegram, Signal, etc., we have two options:

### Option A: Fork NanoClaw, Add Channels

Add additional messaging libraries (grammY for Telegram, etc.) directly into NanoClaw. Each channel adapter implements a common interface:

```typescript
interface MessageChannel {
  connect(): Promise<void>
  onMessage(handler: (msg: InboundMessage) => void): void
  sendMessage(chatId: string, text: string): Promise<void>
}
```

This keeps everything in one container per tenant but grows the NanoClaw codebase.

### Option B: Separate Message Router

Build a lightweight message router service that sits in front of boilerhouse:

```
WhatsApp ──┐
Telegram ──┤
Signal ────┤──► Message Router ──► Boilerhouse API (claim/release)
Discord ───┘         │
                     └──► Forward messages to claimed container
```

The router handles platform connections and maps `(platform, userId)` → `tenantId`. Boilerhouse handles container lifecycle. NanoClaw inside the container just processes messages from a single unified interface.

This is cleaner architecturally but adds another service.

**Recommendation:** Start with Option A (WhatsApp only via NanoClaw as-is), then evaluate Option B when adding a second platform.

## Tasks

- [ ] 1. Build NanoClaw container image (host process, not agent) compatible with boilerhouse volume layout
- [ ] 2. Write workload YAML spec for NanoClaw
- [ ] 3. Test claim/release cycle: sync download → NanoClaw startup → WhatsApp connection → idle TTL → sync upload → release
- [ ] 4. Test affinity: release → reclaim same container → verify WhatsApp session survives
- [ ] 5. Test cold start: release → affinity expires → claim new container → verify sync restores state
- [ ] 6. Configure docker-socket-proxy access for agent container spawning
- [ ] 7. Add agent image pre-pull to deployment
- [ ] 8. Add SQLite backup step to pre-release hook
- [ ] 9. Document WhatsApp QR re-auth flow for cold starts
