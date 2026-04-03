# Pre-Checked Skill Pack Implementation Plan

**Goal:** Ship a curated set of productivity workloads (Google Calendar, Gmail, reminders/todo, web search, weather) that are automatically installed and configured on first run, so a fresh Boilerhouse deployment is useful out of the box.

**Architecture:** A new `workloads/skill-pack/` directory holds the curated workload definitions. A `SkillPackInstaller` module runs at bootstrap time, detects first run via a DB marker, and upserts only the skill-pack workloads that have all required env vars present. API key configuration flows through the existing `api.env` file and `SecretStore`. OAuth tokens are handled as a separate post-install step documented in the dashboard.

---

## Codebase Orientation

**What "skills" means here.** There are two distinct things called "skills" in this repo: (1) Claude Code slash-command skills in `~/.claude/plugins/` — markdown prompt files for Claude, completely unrelated to what we're building; (2) Boilerhouse workloads — TypeScript files that call `defineWorkload(...)`, loaded from `workloads/*.workload.ts`, upserted into SQLite via `loadWorkloadsFromDir`. This plan is entirely about category (2).

**How workloads are loaded.** At API startup (`apps/api/src/bootstrap.ts`), if `WORKLOADS_DIR` env var is set, `loadWorkloadsFromDir(db, dir)` scans for `**/*.workload.ts` files, imports each, calls `resolveWorkloadConfig()`, and upserts the result into the `workloads` table. A `WorkloadWatcher` polls every 5s for changes.

**Secrets.** Global API keys (e.g. `ANTHROPIC_API_KEY`) live in `api.env` and are injected at container proxy-time via `secret("KEY_NAME")` in `defineWorkload`. Per-tenant secrets (e.g. Gmail OAuth token) are stored AES-256-GCM encrypted in `tenant_secrets` and injected as `${tenant-secret:NAME}` in credential headers.

**No existing first-run detection.** Detect first run by checking whether any row exists in the `workloads` table at startup.

---

## File Map

```
workloads/skill-pack/
  google-calendar.workload.ts       curated skill workload definition
  gmail.workload.ts
  reminders.workload.ts
  web-search.workload.ts
  weather.workload.ts
  skill-pack.manifest.ts            machine-readable manifest + required env vars
  README.md                         operator setup guide (API keys, OAuth)

packages/db/src/skill-pack-installer.ts      first-run detection + conditional install
packages/db/src/skill-pack-installer.test.ts
packages/db/src/index.ts                     re-export SkillPackInstaller

apps/api/src/bootstrap.ts                    call installSkillPack() on first run
apps/api/src/routes/system.ts                add GET /skill-pack/status endpoint
apps/cli/src/commands/api-install.ts         add skill-pack env var stubs to api.env
```

---

## Task 1: Skill Pack Manifest

**File:** `workloads/skill-pack/skill-pack.manifest.ts`

```typescript
export interface SkillPackEntry {
  id: string;
  label: string;
  workloadFile: string;
  requiredEnvVars: string[];
  optionalEnvVars: string[];
}

export const SKILL_PACK_MANIFEST: SkillPackEntry[] = [
  {
    id: "skill-google-calendar",
    label: "Google Calendar",
    workloadFile: "google-calendar.workload.ts",
    requiredEnvVars: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    optionalEnvVars: ["GOOGLE_CALENDAR_ID"],
  },
  {
    id: "skill-gmail",
    label: "Gmail",
    workloadFile: "gmail.workload.ts",
    requiredEnvVars: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    optionalEnvVars: [],
  },
  {
    id: "skill-reminders",
    label: "Reminders & Todo",
    workloadFile: "reminders.workload.ts",
    requiredEnvVars: [],
    optionalEnvVars: [],
  },
  {
    id: "skill-web-search",
    label: "Web Search",
    workloadFile: "web-search.workload.ts",
    requiredEnvVars: ["BRAVE_SEARCH_API_KEY"],
    optionalEnvVars: [],
  },
  {
    id: "skill-weather",
    label: "Weather",
    workloadFile: "weather.workload.ts",
    requiredEnvVars: ["OPENWEATHER_API_KEY"],
    optionalEnvVars: [],
  },
];
```

### Tests (add to `workloads/workloads.test.ts`)

- Manifest is a non-empty array.
- Every entry has `id`, `workloadFile`, `requiredEnvVars`, `optionalEnvVars`.
- All `workloadFile` values end with `.workload.ts`.

---

## Task 2: Skill Pack Workload Definitions

**Files:** `workloads/skill-pack/*.workload.ts`

Each workload uses `defineWorkload` from `@boilerhouse/core` with the pattern already used in `openclaw.workload.ts`. The existing glob test in `workloads/workloads.test.ts` uses `**/*.workload.ts` recursively, so new files inside `skill-pack/` are auto-discovered.

**Key fields per workload:**

| Skill | Image | Required creds | Network allowlist |
|-------|-------|----------------|-------------------|
| google-calendar | `ghcr.io/boilerhouse/skill-google-calendar:latest` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` via `secret()` | googleapis.com, accounts.google.com |
| gmail | `ghcr.io/boilerhouse/skill-gmail:latest` | Same Google creds | + gmail.googleapis.com |
| reminders | `ghcr.io/boilerhouse/skill-reminders:latest` | None | `[]` (offline) |
| web-search | `ghcr.io/boilerhouse/skill-web-search:latest` | `BRAVE_SEARCH_API_KEY` via `secret()` | api.search.brave.com |
| weather | `ghcr.io/boilerhouse/skill-weather:latest` | `OPENWEATHER_API_KEY` via `secret()` | api.openweathermap.org |

All use: `expose: [{ guest: 8080, host_range: [30200, 30299] }]`, `websocket: "/ws"`, `http_get: { path: "/health", port: 8080 }`, `idle: { timeout_seconds: 300, action: "hibernate" }`.

**Note:** Image refs are placeholders until real skill images are published. Workloads will enter `error` status when the pool manager can't pull them — visible in `/skill-pack/status`.

**Port range note:** `host_range: [30200, 30299]` — verify no overlap with existing workload port ranges before deploying.

---

## Task 3: `SkillPackInstaller`

**File:** `packages/db/src/skill-pack-installer.ts`

### `isFirstRun(db: DrizzleDb): boolean`

Returns `true` when `count(*)` on the `workloads` table is 0. Uses the existing SQLite single-writer model — no race conditions in single-node deployment.

### `installSkillPack(db, skillPackDir): Promise<SkillPackInstallResult>`

For each entry in `SKILL_PACK_MANIFEST`:
1. Check `requiredEnvVars` against `process.env`. If any missing → add to `skipped`.
2. Dynamic `import()` the workload file from `skillPackDir/workloadFile`.
3. Call `resolveWorkloadConfig(mod.default)`.
4. Check if workload with same `name` + `version` already exists (idempotent).
5. Insert with `status: "creating"`.
6. Catch import/resolve errors → add to `errors` (non-fatal).

```typescript
export interface SkillInstallRecord { id: string; label: string; workloadId: string; }
export interface SkillSkipRecord { id: string; label: string; missingEnvVars: string[]; }
export interface SkillPackInstallResult {
  installed: SkillInstallRecord[];
  skipped: SkillSkipRecord[];
  errors: Array<{ id: string; error: string }>;
}
```

### Tests (`skill-pack-installer.test.ts`)

- `isFirstRun` returns `true` on empty DB, `false` after a workload row exists.
- `installSkillPack` installs skills whose required env vars are set.
- `installSkillPack` skips skills whose required env vars are absent.
- `installSkillPack` returns errors array for bad directory (no throw).
- Idempotent: calling twice doesn't duplicate rows.

---

## Task 4: Export from `@boilerhouse/db`

In `packages/db/src/index.ts`, add:

```typescript
export { isFirstRun, installSkillPack } from "./skill-pack-installer";
export type { SkillPackInstallResult, SkillInstallRecord, SkillSkipRecord } from "./skill-pack-installer";
```

---

## Task 5: Wire into Bootstrap

**File:** `apps/api/src/bootstrap.ts`

Add `skillPackDir?: string` to `BootstrapConfig`. Populate from `process.env.SKILL_PACK_DIR` in `configFromEnv()`.

After `initDatabase(config.dbPath)`, before `WorkloadWatcher`:

```typescript
if (config.skillPackDir && isFirstRun(db)) {
  log.info({ skillPackDir: config.skillPackDir }, "First run detected — installing skill pack");
  const packResult = await installSkillPack(db, config.skillPackDir);
  log.info(
    {
      installed: packResult.installed.map((r) => r.id),
      skipped: packResult.skipped.map((s) => ({ id: s.id, missing: s.missingEnvVars })),
      errors: packResult.errors,
    },
    "Skill pack install complete",
  );
}
```

---

## Task 6: Skill Pack Status Endpoint

**File:** `apps/api/src/routes/system.ts`

Add `GET /skill-pack/status`:

```typescript
.get("/skill-pack/status", () => {
  const skills = SKILL_PACK_MANIFEST.map((entry) => {
    const row = db.select({ workloadId: workloads.workloadId, status: workloads.status })
      .from(workloads)
      .where(eq(workloads.name, entry.id))
      .get();
    const missingEnvVars = entry.requiredEnvVars.filter((v) => !process.env[v]);
    return {
      id: entry.id,
      label: entry.label,
      installed: !!row,
      workloadId: row?.workloadId ?? null,
      workloadStatus: row?.status ?? null,
      missingEnvVars: row ? [] : missingEnvVars,
    };
  });
  return { skills };
})
```

### Tests (add to `system.test.ts`)

- `GET /skill-pack/status` returns 200 with `{ skills: [] }` or similar array.

---

## Task 7: API Key Stubs in `api-install.ts`

**File:** `apps/cli/src/commands/api-install.ts`

Extract env file generation into an exported `generateApiEnvContent(dataDir: string): string` function. Add to the generated `api.env`:

```ini
# ── Skill Pack ────────────────────────────────────────────────────────────
# Path to the curated skill pack workload definitions.
SKILL_PACK_DIR=/etc/boilerhouse/skill-pack

# Google Calendar & Gmail
#GOOGLE_CLIENT_ID=
#GOOGLE_CLIENT_SECRET=
#GOOGLE_CALENDAR_ID=primary

# Web Search (Brave Search API)
#BRAVE_SEARCH_API_KEY=

# Weather (OpenWeatherMap)
#OPENWEATHER_API_KEY=
```

### Tests (add to `api-install.test.ts`)

- `generateApiEnvContent` includes `SKILL_PACK_DIR=`, `GOOGLE_CLIENT_ID=`, `BRAVE_SEARCH_API_KEY=`, `OPENWEATHER_API_KEY=`.
- Core vars (`RUNTIME_TYPE`, `BOILERHOUSE_SECRET_KEY`) are still present.

---

## Task 8: Setup Guide README

**File:** `workloads/skill-pack/README.md`

Human-readable guide covering:
- Quick start: edit `api.env`, restart, check `/skill-pack/status`
- Per-skill setup: Google Cloud Console steps for Google OAuth, Brave Search signup, OpenWeatherMap signup
- Per-tenant OAuth flow: `GET /skill-oauth/start/google?tenant=<id>`
- Installing a skill after first run (manual API call)
- OAuth token lifecycle and refresh behaviour

---

## Task 9: Deploy skill-pack files during `api install`

**File:** `apps/cli/src/commands/api-install.ts`

Export `copySkillPackToDir(destDir: string): void` — copies `*.workload.ts`, `*.trigger.ts`, `*.manifest.ts`, and `README.md` from the bundled `workloads/skill-pack/` to `destDir`. Call it during `apiInstallCommand` to place files at `/etc/boilerhouse/skill-pack/`.

Update `apps/cli/src/embedded/api.service.ts` systemd unit:

```
ReadOnlyPaths=/etc/boilerhouse
```

So the `boilerhouse` service user can read the skill-pack files.

---

## Task 10: Docker Compose Integration

**File:** `docker-compose.yml`

Add to `api` service:

```yaml
environment:
  - SKILL_PACK_DIR=/workloads/skill-pack
  # Uncomment to enable Google skills:
  # - GOOGLE_CLIENT_ID=
  # - GOOGLE_CLIENT_SECRET=
  # Uncomment to enable Web Search:
  # - BRAVE_SEARCH_API_KEY=
  # Uncomment to enable Weather:
  # - OPENWEATHER_API_KEY=
volumes:
  - ./workloads/skill-pack:/workloads/skill-pack:ro
```

---

## Configuration: Required API Keys

| Skill | Env Var | Where to get it |
|-------|---------|----------------|
| Google Calendar | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | console.cloud.google.com → OAuth 2.0 Credentials |
| Gmail | Same as above | Enable Gmail API in same project |
| Web Search | `BRAVE_SEARCH_API_KEY` | api.search.brave.com (2000 free queries/month) |
| Weather | `OPENWEATHER_API_KEY` | openweathermap.org/api (free tier) |
| Reminders | None | Auto-installs |

---

## Risk Notes

- **OAuth token lifecycle**: Tokens expire. Skill containers must refresh and persist updated tokens before old ones expire. Containers should implement pre-expiry refresh (~5 min window).
- **Skill images not yet published**: Workloads will show `workloadStatus: "error"` until real images are published at the referenced `ghcr.io/boilerhouse/skill-*:latest` tags.
- **Port range**: `host_range: [30200, 30299]` — verify no overlap with existing workloads before deploying to an existing installation.
- **First-run race condition**: Not possible in current single-node, single-writer SQLite deployment. Multi-node would need a DB advisory lock.
