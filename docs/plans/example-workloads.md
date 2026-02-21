# Example Workloads

Ship a set of `.toml` workload definitions that serve as both local development fixtures and reference examples for new users.

## Workloads

### 1. OpenClaw

Autonomous AI agent with a gateway + sandbox architecture. Node.js (TypeScript).

```toml
[workload]
name = "openclaw"
version = "0.1.0"

[image]
ref = "alpine/openclaw:main"

[resources]
vcpus = 2
memory_mb = 2048
disk_gb = 10

[network]
access = "restricted"
allowlist = [
  "api.anthropic.com",
  "api.openai.com",
  "registry.npmjs.org",
]
expose = [{ guest = 18789, host_range = [30000, 30099] }]

[filesystem]
overlay_dirs = ["/root/.openclaw"]

[idle]
timeout_seconds = 600
action = "hibernate"

[health]
interval_seconds = 10
unhealthy_threshold = 3

[health.http_get]
path = "/health"
port = 18789

[entrypoint]
cmd = "node"
args = ["dist/index.js"]

[metadata]
description = "OpenClaw autonomous AI agent"
homepage = "https://github.com/openclaw/openclaw"
```

### 2. Nanobot

Ultra-lightweight AI agent gateway. Python.

```toml
[workload]
name = "nanobot"
version = "0.1.0"

[image]
dockerfile = "workloads/nanobot/Dockerfile"

[resources]
vcpus = 1
memory_mb = 1024
disk_gb = 2

[network]
access = "restricted"
allowlist = [
  "api.anthropic.com",
  "api.openai.com",
  "openrouter.ai",
]
expose = [{ guest = 18790, host_range = [30100, 30199] }]

[filesystem]
overlay_dirs = ["/root/.nanobot"]

[idle]
timeout_seconds = 300
action = "hibernate"

[health]
interval_seconds = 10
unhealthy_threshold = 3

[health.exec]
command = ["nanobot", "status"]

[entrypoint]
cmd = "nanobot"
args = ["gateway"]

[metadata]
description = "Nanobot lightweight AI agent"
homepage = "https://github.com/HKUDS/nanobot"
```

### 3. Claude Code

Anthropic's agentic coding CLI. Node.js (TypeScript). No listening port — outbound-only.

```toml
[workload]
name = "claude-code"
version = "0.1.0"

[image]
dockerfile = "workloads/claude-code/Dockerfile"

[resources]
vcpus = 2
memory_mb = 4096
disk_gb = 5

[network]
access = "restricted"
allowlist = [
  "api.anthropic.com",
  "statsig.anthropic.com",
  "statsig.com",
  "sentry.io",
  "*.sentry.io",
  "registry.npmjs.org",
  "raw.githubusercontent.com",
  "*.github.com",
]

[filesystem]
overlay_dirs = ["/home/user/workspace"]

[idle]
watch_dirs = ["/home/user/workspace"]
timeout_seconds = 900
action = "hibernate"

[health]
interval_seconds = 15
unhealthy_threshold = 3

[health.exec]
command = ["claude", "--version"]

[entrypoint]
cmd = "claude"
args = ["--dangerously-skip-permissions"]
env = { HOME = "/home/user" }

[metadata]
description = "Claude Code agentic coding CLI"
homepage = "https://github.com/anthropics/claude-code"
```

---

## File Layout

```
workloads/
├── openclaw.toml
├── nanobot/
│   ├── nanobot.toml
│   └── Dockerfile
└── claude-code/
    ├── claude-code.toml
    └── Dockerfile
```

- OpenClaw uses a published image (`alpine/openclaw:main`), so it only needs the `.toml`.
- Nanobot and Claude Code have no official images, so they each get a `Dockerfile` alongside the `.toml`.

## Dockerfiles

### `workloads/nanobot/Dockerfile`

```dockerfile
FROM python:3.12-slim

RUN pip install --no-cache-dir nanobot-ai

ENTRYPOINT ["nanobot"]
CMD ["gateway"]
```

### `workloads/claude-code/Dockerfile`

Based on Anthropic's reference devcontainer.

```dockerfile
FROM node:20-slim

RUN npm install -g @anthropic-ai/claude-code@latest

RUN useradd -m user
USER user
WORKDIR /home/user/workspace

ENTRYPOINT ["claude"]
CMD ["--dangerously-skip-permissions"]
```

## Workload Loader (`@boilerhouse/db`)

A `WorkloadLoader` that syncs `.toml` files from a directory into the database. Lives in `packages/db/` since it only needs `DrizzleDb` + `parseWorkload` — no API dependency.

### Interface

```ts
// packages/db/src/workload-loader.ts

export interface WorkloadLoaderResult {
  loaded:   number;  // new workloads inserted
  updated:  number;  // existing workloads with config changes
  unchanged: number; // already up-to-date, skipped
  errors:   Array<{ file: string; error: string }>;
}

/**
 * Scan a directory for *.toml files, parse each, and upsert into the DB.
 *
 * Match on (name, version). If the config has changed, update it.
 * If it already matches, skip.
 *
 * @param db - Drizzle database instance
 * @param dir - Absolute path to the workloads directory
 */
export function loadWorkloadsFromDir(db: DrizzleDb, dir: string): WorkloadLoaderResult;
```

### Behavior

1. Glob `dir/**/*.toml`.
2. For each file, read and `parseWorkload(toml)`. Collect parse errors into `errors` (don't abort).
3. Look up existing row by `(name, version)`.
   - **Not found** → insert with a new `WorkloadId`. Increment `loaded`.
   - **Found, config differs** → update `config` and `updatedAt`. Increment `updated`.
   - **Found, config identical** → skip. Increment `unchanged`.
4. Return the result summary.

This is an upsert-by-content: the `.toml` files on disk are the source of truth. Edit the file, restart the server, and the DB catches up.

### Server Integration

Add a `WORKLOADS_DIR` env var to `server.ts`. If set, call `loadWorkloadsFromDir` at startup before accepting requests:

```ts
// apps/api/src/server.ts
const workloadsDir = process.env.WORKLOADS_DIR;

if (workloadsDir) {
  const result = loadWorkloadsFromDir(db, workloadsDir);
  console.log(
    `Workloads: ${result.loaded} loaded, ${result.updated} updated, ` +
    `${result.unchanged} unchanged, ${result.errors.length} errors`,
  );
  for (const { file, error } of result.errors) {
    console.error(`  ${file}: ${error}`);
  }
}
```

For local dev, set it in `.env`:

```env
WORKLOADS_DIR=./workloads
```

This replaces the seed script — no separate step needed. Start the server and workloads are loaded.

## Tests

### Parse validation (`workloads/workloads.test.ts`)

Glob all `.toml` files from `workloads/`, run each through `parseWorkload`, assert no errors. Catches schema drift.

### Loader unit tests (`packages/db/src/workload-loader.test.ts`)

Using `createTestDatabase()` and temp directories with fixture `.toml` files:

- **loads new workloads** — empty DB, dir with 2 files → `loaded: 2`
- **skips unchanged** — load once, load again → `unchanged: 2` on second run
- **updates changed config** — load, modify a `.toml`, load again → `updated: 1`
- **collects parse errors** — dir with one valid and one invalid `.toml` → `loaded: 1, errors: [...]`
- **handles empty directory** — no `.toml` files → all zeros

## Implementation Steps

1. Create `workloads/` directory and the three `.toml` files.
2. Create the two `Dockerfile`s for nanobot and claude-code.
3. Write `workloads/workloads.test.ts` — glob all `.toml`, parse each, assert no errors.
4. Write loader tests in `packages/db/src/workload-loader.test.ts`.
5. Implement `loadWorkloadsFromDir` in `packages/db/src/workload-loader.ts`.
6. Export from `packages/db/src/index.ts`.
7. Wire into `server.ts` behind `WORKLOADS_DIR` env var.
8. Run tests, lint, verify everything passes.
