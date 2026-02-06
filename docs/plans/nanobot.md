# Nanobot Integration

## Overview

Evaluate [nanobot](https://github.com/HKUDS/nanobot) (HKUDS) as an alternative to [NanoClaw](nanoclaw.md) for the boilerhouse AI assistant workload. Each tenant gets their own nanobot instance, with boilerhouse handling container pooling, state sync, and idle expiry.

## What Is Nanobot

Nanobot is an ultra-lightweight personal AI assistant framework from the University of Hong Kong. ~4,000 lines of Python, MIT-licensed, installable via `pip install nanobot-ai`.

Key properties:
- **Multi-platform messaging** — Telegram, Discord, WhatsApp, Feishu out of the box
- **Multi-provider LLM** — 9 providers via litellm (Anthropic, OpenAI, OpenRouter, DeepSeek, Groq, Gemini, vLLM, Moonshot, Zhipu)
- **Single-process** — no nested containers, no container-per-invocation
- **Config-driven** — JSON config + env var overrides, no code modification needed
- **Persistent memory** — daily markdown notes + long-term MEMORY.md

## Why Nanobot Over NanoClaw

| Dimension                | Nanobot                                      | NanoClaw                                   |
| ------------------------ | -------------------------------------------- | ------------------------------------------ |
| Language                 | Python (~4,000 lines)                        | TypeScript (~500 lines)                    |
| Messaging platforms      | Telegram, Discord, WhatsApp, Feishu          | WhatsApp only                              |
| LLM providers            | 9 via litellm (runtime switchable)           | Claude only (Agent SDK)                    |
| Container model          | Single process, no nested containers         | Spawns ephemeral containers per invocation |
| Docker socket needed     | **No**                                       | Yes (for agent containers)                 |
| Configuration            | JSON config + env vars                       | Code modification                          |
| Tenant provisioning      | Drop in a `config.json`                      | Fork and modify code                       |
| Security model           | Application-level workspace restriction      | OS-level container isolation               |
| Agent tool isolation     | Process-level (shared workspace)             | Container-level (per-group filesystem)     |

### The Critical Difference: No Nested Containers

NanoClaw's core design spawns a new Docker container for every message interaction. Inside a boilerhouse-managed container, this requires Docker-in-Docker or Docker socket access — both add complexity and weaken isolation.

Nanobot runs the agent loop in-process. The LLM calls litellm, tool calls execute in the same process, results come back. No Docker socket, no container spawning, no DinD. This is a clean fit for boilerhouse's model: one process per container, boilerhouse owns the full container lifecycle.

### The Tradeoff: Weaker Tool Isolation

NanoClaw's per-invocation containers mean a misbehaving agent can't corrupt the host process or persist state beyond its sandbox. Nanobot's in-process tools (shell exec, file ops) share the same filesystem and process. The `restrict_to_workspace` config helps but is application-level, not OS-level.

For our use case (personal AI assistants where each tenant has their own container), this tradeoff is acceptable — boilerhouse provides the OS-level isolation boundary at the container level. Each tenant's nanobot runs in its own container with its own filesystem.

## Nanobot Architecture

```
nanobot gateway (single Python process, port 18790)
├── ChannelManager
│   ├── Telegram (python-telegram-bot)
│   ├── Discord (native WebSocket)
│   ├── WhatsApp (Node.js baileys bridge, ws://localhost:3001)
│   └── Feishu (WebSocket long-connection)
├── MessageBus (asyncio.Queue inbound/outbound)
├── AgentLoop
│   ├── Receives InboundMessage from bus
│   ├── Loads/creates session (JSONL file)
│   ├── Builds context (session history + memory)
│   ├── LLM tool loop (up to 20 iterations):
│   │   ├── Call LLM with tool definitions
│   │   ├── Execute tool calls (file, shell, web, spawn)
│   │   └── Append results, repeat
│   └── Persist session, emit OutboundMessage
├── SessionManager (JSONL files per chat)
├── Memory (daily markdown + long-term MEMORY.md)
└── CronScheduler (croniter-based scheduled tasks)
```

### Filesystem Layout

All state lives under a single directory (`~/.nanobot/` by default):

```
~/.nanobot/
├── config.json                     # All configuration (channels, providers, tools)
├── sessions/
│   ├── telegram_12345.jsonl        # Per-chat session history
│   ├── discord_67890.jsonl
│   └── whatsapp_15551234567.jsonl
└── workspace/
    ├── memory/
    │   ├── MEMORY.md               # Long-term persistent memory
    │   └── 2026-02-06.md           # Daily memory files
    └── <agent-created files>       # Files the agent creates during tasks
```

### Channel Authentication

| Platform  | Auth Method        | Pre-warmable? | Notes                              |
| --------- | ------------------ | ------------- | ---------------------------------- |
| Telegram  | Bot token          | Yes           | Token in config.json, instant auth |
| Discord   | Bot token          | Yes           | Token in config.json, instant auth |
| WhatsApp  | QR code pairing    | No            | Interactive, requires `nanobot channels login` |
| Feishu    | App ID + secret    | Yes           | Tokens in config.json              |

Telegram and Discord are ideal for pre-warmed containers — auth is a static token. WhatsApp requires interactive QR pairing and is harder to automate.

## Integration Strategy

### Single Volume Mount

Nanobot's `~/.nanobot/` directory maps directly to boilerhouse's state directory:

```
Boilerhouse state dir              Nanobot expects
────────────────────               ────────────────
/var/lib/boilerhouse/states/{id}/  →  /root/.nanobot/
├── config.json                       (channels, providers, tools)
├── sessions/                         (JSONL conversation history)
└── workspace/                        (memory, agent files)
```

One volume mount. No `comm` or custom volumes needed. No Docker socket needed.

### Tenant Provisioning

Each tenant needs a `config.json` with their credentials. On claim, boilerhouse syncs it from S3 into the state directory. Nanobot reads it on startup.

```json
{
  "agents": {
    "defaults": {
      "model": "anthropic/claude-sonnet-4-5-20250929",
      "max_tokens": 8192,
      "workspace": "/root/.nanobot/workspace"
    }
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "token": "{{TENANT_BOT_TOKEN}}",
      "allow_from": ["{{TENANT_USER_ID}}"]
    }
  },
  "providers": {
    "anthropic": {
      "api_key": "{{TENANT_API_KEY}}"
    }
  },
  "tools": {
    "restrict_to_workspace": true,
    "exec": { "timeout": 60 }
  }
}
```

No code changes needed per tenant — just a different config file.

### Workload Spec

```yaml
id: nanobot
name: Nanobot AI Assistant
image: nanobot:latest

command: ["nanobot", "gateway"]

environment:
  NANOBOT_GATEWAY__HOST: "0.0.0.0"
  NANOBOT_GATEWAY__PORT: "18790"

volumes:
  state:
    target: /root/.nanobot
  secrets:
    target: /run/secrets/nanobot
    read_only: true

security:
  user: 0  # nanobot expects /root/.nanobot; revisit with custom HOME

resources:
  limits:
    cpus: 1
    memory: 1024

healthcheck:
  test: ["CMD", "curl", "-sf", "http://localhost:18790/"]
  interval: 30
  timeout: 5
  retries: 3
  start_period: 15

pool:
  min_size: 2
  max_size: 50
  file_idle_ttl_ms: 300000  # 5 min idle before release

sync:
  sink:
    type: s3
    bucket: boilerhouse-nanobot
    region: us-east-1

  mappings:
    # Session history (conversation continuity)
    - path: sessions
      direction: bidirectional
      mode: sync

    # Workspace and memory (agent state, long-term memory)
    - path: workspace
      direction: bidirectional
      mode: sync

    # Config (tenant credentials and settings)
    - path: config.json
      direction: download
      mode: copy

  policy:
    on_claim: true
    on_release: true
    interval: 60000
    manual: true
```

### Claim/Release Lifecycle

| Event              | What Happens                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| **Claim**          | Sync downloads tenant's config.json, sessions, and workspace from S3. `nanobot gateway` starts.  |
| **Active**         | Nanobot connects to configured channels, processes messages, writes sessions and memory.          |
| **Idle TTL fires** | No filesystem writes for `file_idle_ttl_ms`. Final sync upload. Container released to pool.      |
| **Affinity hit**   | Tenant reclaims same container. Process still running, channels still connected. Zero latency.    |
| **Affinity miss**  | Tenant gets fresh container. Full sync download. Channels reconnect (instant for token-based).    |

### Filesystem Idle TTL Integration

Uses the [filesystem TTL expiry](filesystem-ttl-expiry.md) feature. Nanobot writes to `~/.nanobot/` whenever:
- A message is received and processed (session JSONL appended)
- Memory is updated (daily or long-term markdown)
- A scheduled task executes
- The agent creates files in the workspace

When the user stops chatting, these writes stop. The idle reaper detects the silence and triggers release.

## Comparison: Nanobot vs NanoClaw for Boilerhouse

### Operational Complexity

| Concern                    | Nanobot                              | NanoClaw                                   |
| -------------------------- | ------------------------------------ | ------------------------------------------ |
| Docker socket access       | Not needed                           | Required (agent containers)                |
| Image pre-pull             | Not needed                           | ~1GB agent image must be pre-pulled        |
| Volume mounts              | 1 (state dir)                        | 3+ (state, secrets, comm, store)           |
| Process model              | Single Python process                | Node.js host + N ephemeral containers      |
| Container resource usage   | ~200-500MB per tenant                | ~500MB host + ~1GB per agent invocation    |
| Startup time               | Sub-second (Python process)          | Sub-second host, but container spawn per msg |
| Health check               | Gateway port 18790                   | No documented health endpoint              |

### Security

| Concern                    | Nanobot                              | NanoClaw                                   |
| -------------------------- | ------------------------------------ | ------------------------------------------ |
| Agent tool isolation       | Process-level (shared workspace)     | Container-level (per-invocation)           |
| Filesystem isolation       | `restrict_to_workspace` (app-level)  | Mount isolation (OS-level)                 |
| Container escape risk      | None (no Docker access)              | Docker socket access = potential escape    |
| Blast radius of compromise | Tenant's workspace only              | Tenant's workspace + Docker API access     |

Nanobot is paradoxically more secure *in practice* despite weaker tool isolation, because it doesn't require Docker socket access. NanoClaw's OS-level isolation per invocation is stronger in theory, but the Docker socket requirement undermines the container boundary.

### Multi-Platform Messaging

| Concern                    | Nanobot                              | NanoClaw                                   |
| -------------------------- | ------------------------------------ | ------------------------------------------ |
| Built-in platforms         | Telegram, Discord, WhatsApp, Feishu  | WhatsApp only                              |
| Adding platforms           | Implement `BaseChannel`, drop in     | Fork codebase, modify code                 |
| Token-based auth           | Telegram, Discord, Feishu            | None (WhatsApp QR only)                    |
| Pre-warmable channels      | 3 of 4                               | 0 of 1                                     |

Nanobot's multi-platform support eliminates the need to build our own messaging adapter layer (discussed in the NanoClaw plan under "Multi-Platform Messaging (Future)").

### LLM Flexibility

| Concern                    | Nanobot                              | NanoClaw                                   |
| -------------------------- | ------------------------------------ | ------------------------------------------ |
| Providers                  | 9 (via litellm)                      | Claude only (Agent SDK)                    |
| Runtime model switching    | Yes (config change)                  | No (hardcoded)                             |
| Tenant brings own key      | Yes (per-tenant config.json)         | Requires code change                       |
| Local model support        | Yes (vLLM with OpenAI-compatible API)| No                                         |

### Tenant Provisioning

| Concern                    | Nanobot                              | NanoClaw                                   |
| -------------------------- | ------------------------------------ | ------------------------------------------ |
| New tenant setup           | Write config.json, sync to S3       | Fork code, configure, build image          |
| Credential injection       | config.json or env vars              | .env file + code configuration             |
| Per-tenant customization   | Config fields                        | Code modification                          |

## Challenges

### 1. Root User

Nanobot defaults to `~/.nanobot/` which resolves to `/root/.nanobot` in Docker. The Dockerfile doesn't create a non-root user. Running as root inside the container is acceptable when boilerhouse provides the isolation boundary, but for defense-in-depth:

**Mitigation:** Set `HOME=/home/nanobot` in the container environment and create the user in a custom Dockerfile layer. Or accept root-in-container since boilerhouse's container isolation + read-only rootfs + resource limits contain the blast radius.

### 2. WhatsApp Node.js Bridge

Nanobot's WhatsApp channel uses a Node.js baileys bridge process (`ws://localhost:3001`). This adds Node.js as a dependency inside the Python container.

**Mitigation:** The official Dockerfile already includes Node.js 20. For tenants using only Telegram/Discord, the bridge doesn't start and has no overhead. For WhatsApp tenants, the same QR pairing limitation applies as with NanoClaw.

### 3. No External API

Nanobot has no REST API for programmatic access. All interaction flows through messaging channels or CLI. Boilerhouse cannot send messages to the agent or query its state programmatically.

**Mitigation:** For the messaging use case, this is fine — messages arrive via the channel. If we later need programmatic control, we could add a simple HTTP handler or use nanobot's `MessageTool` inter-agent communication.

### 4. Session File Growth

JSONL session files grow without bound. A very active tenant could accumulate large session files over time.

**Mitigation:**
- Periodic session rotation/truncation (keep last N messages, archive older)
- Sync only the active session files (not archived ones) for faster claim/release
- Monitor session file sizes via the idle reaper or a separate cleanup job

### 5. Gateway Port Binding

Every nanobot container binds to port 18790. This is fine — boilerhouse containers each have their own network namespace, so there's no port conflict. The port is only used by channel adapters (Feishu) and the health check.

### 6. Workspace Security

With `restrict_to_workspace: false` (default), the agent can read/write anywhere in the container filesystem. With `restrict_to_workspace: true`, file and shell operations are confined to `~/.nanobot/workspace/`.

**Recommendation:** Always set `restrict_to_workspace: true` in tenant configs. Combined with boilerhouse's container isolation, this provides defense-in-depth.

## Recommendation

**Use nanobot instead of NanoClaw.** The key reasons:

1. **No Docker socket** — eliminates the biggest security and complexity concern from the NanoClaw plan
2. **Multi-platform messaging built in** — Telegram and Discord work with static tokens, ideal for pre-warmed containers
3. **Config-driven provisioning** — new tenants are a `config.json` upload, not a code fork
4. **Lighter resource footprint** — single Python process vs host + ephemeral containers
5. **Multi-provider LLM** — tenants can use Claude, GPT, DeepSeek, or local models

The main thing we give up is NanoClaw's per-invocation container isolation for agent tools. But boilerhouse already provides per-tenant container isolation, and `restrict_to_workspace: true` adds an application-level boundary within that.

## Tasks

- [ ] 1. Build nanobot container image with custom non-root user and `HOME=/home/nanobot`
- [ ] 2. Write workload YAML spec for nanobot
- [ ] 3. Create tenant provisioning script: generate `config.json` from template, upload to S3
- [ ] 4. Test claim/release cycle: sync download → nanobot gateway startup → Telegram connect → idle TTL → sync upload → release
- [ ] 5. Test affinity: release → reclaim same container → verify Telegram session survives
- [ ] 6. Test cold start: release → affinity expires → claim new container → verify sync restores sessions and memory
- [ ] 7. Test WhatsApp channel: QR pairing flow, session persistence across claim/release
- [ ] 8. Benchmark resource usage: memory and CPU per idle tenant, per active tenant
- [ ] 9. Write tenant onboarding docs (Telegram bot setup, config generation)
