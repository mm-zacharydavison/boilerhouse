# Container-Scoped API Keys

**Goal:** Provision short-lived, scoped API keys for agent containers so they can call
the Boilerhouse API with limited permissions. Keys are created when a container is
claimed and automatically revoked when the container is destroyed. This is the
infrastructure layer that wake-up tasks, GitHub Issues skills, and any future agent-facing
API access depends on.

**Key design principles:**

1. **Ephemeral.** Keys live only as long as the container. No long-lived agent credentials.
2. **Scoped.** Each key is bound to a specific tenant, workload, and instance. The key
   can only access API endpoints and actions permitted by its scope.
3. **Injected automatically.** The container receives `BOILERHOUSE_API_KEY` and
   `BOILERHOUSE_API_URL` as environment variables at creation time. The agent doesn't
   request a key — it just uses the env vars.
4. **No new auth protocol.** Keys are opaque bearer tokens validated by the existing
   `authMiddleware` pattern — just with per-key scope checking added.

---

## Architecture

```
Container claimed (TenantManager.claim)
  → generateContainerApiKey()
  → store in container_api_keys table (instanceId, tenantId, workload, scopes, expiresAt)
  → inject BOILERHOUSE_API_KEY and BOILERHOUSE_API_URL into container env
  → container starts

Agent makes API call
  → Authorization: Bearer <container-api-key>
  → authMiddleware resolves key → looks up scope
  → checks requested endpoint against allowed scopes
  → 200 (allowed) or 403 (scope denied)

Container destroyed
  → delete from container_api_keys where instanceId = <id>
  → key is immediately invalid
```

---

## Scope Model

Scopes are coarse-grained permissions. An API key has a set of scopes; each API endpoint
requires a specific scope.

```typescript
export type ApiKeyScope =
  | "agent-triggers:read"     // GET /api/v1/agent-triggers
  | "agent-triggers:write"    // POST/DELETE /api/v1/agent-triggers
  | "secrets:read"            // GET /api/v1/tenants/:id/secrets (own tenant only)
  | "secrets:write"           // PUT /api/v1/tenants/:id/secrets (own tenant only)
  | "issues:write"            // POST to external issue tracker (if proxied)
  | "workloads:read"          // GET /api/v1/workloads (read-only)
  | "health:read";            // GET /api/v1/health
```

**Default scopes for agent containers:**

```typescript
const DEFAULT_AGENT_SCOPES: ApiKeyScope[] = [
  "agent-triggers:read",
  "agent-triggers:write",
  "secrets:read",
  "workloads:read",
  "health:read",
];
```

Workload definitions can override scopes via a new `apiScopes` field:

```typescript
// In a workload definition:
export default defineWorkload({
  name: "assistant",
  // ...
  apiAccess: {
    scopes: ["agent-triggers:read", "agent-triggers:write", "health:read"],
    // Or: scopes: "none" to disable API access entirely
  },
});
```

If `apiAccess` is absent, the container gets the default scopes. If `apiAccess.scopes`
is `"none"`, no key is provisioned and no env vars are injected.

---

## Schema: `container_api_keys` Table

### `packages/db/src/schema.ts`

```typescript
export const containerApiKeys = sqliteTable("container_api_keys", {
  /** The bearer token itself. Opaque, 32-byte hex string. */
  key: text("key").primaryKey(),
  /** Instance this key belongs to. Deleted when the instance is destroyed. */
  instanceId: text("instance_id").notNull().$type<InstanceId>(),
  /** Tenant this key is scoped to. Agent can only access own tenant's resources. */
  tenantId: text("tenant_id").notNull().$type<TenantId>(),
  /** Workload name. Used for scope resolution and audit. */
  workload: text("workload").notNull(),
  /** JSON array of ApiKeyScope strings. */
  scopes: jsonObject<string[]>("scopes").notNull(),
  /** Hard expiry. Keys are rejected after this time even if not revoked. */
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull(),
}, (table) => [
  index("container_api_keys_instance_id_idx").on(table.instanceId),
  index("container_api_keys_tenant_id_idx").on(table.tenantId),
]);

export type ContainerApiKeyRow = typeof containerApiKeys.$inferSelect;
```

### Migration: `packages/db/drizzle/0017_container_api_keys.sql`

```sql
CREATE TABLE `container_api_keys` (
  `key` text PRIMARY KEY NOT NULL,
  `instance_id` text NOT NULL,
  `tenant_id` text NOT NULL,
  `workload` text NOT NULL,
  `scopes` text NOT NULL,
  `expires_at` integer NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `container_api_keys_instance_id_idx` ON `container_api_keys` (`instance_id`);
--> statement-breakpoint
CREATE INDEX `container_api_keys_tenant_id_idx` ON `container_api_keys` (`tenant_id`);
```

---

## Key Lifecycle

### Provisioning (on claim)

**Modified: `apps/api/src/bootstrap.ts`** (or wherever `TenantManager.claim` result is
handled)

After a successful claim, before the container starts accepting requests:

```typescript
import { randomBytes } from "node:crypto";

function provisionContainerApiKey(
  db: DrizzleDb,
  instanceId: InstanceId,
  tenantId: TenantId,
  workload: string,
  scopes: ApiKeyScope[],
  ttlMs: number = 24 * 60 * 60 * 1000,  // 24h default
): string {
  const key = randomBytes(32).toString("hex");
  const now = new Date();

  db.insert(containerApiKeys).values({
    key,
    instanceId,
    tenantId,
    workload,
    scopes,
    expiresAt: new Date(now.getTime() + ttlMs),
    createdAt: now,
  }).run();

  return key;
}
```

The key is injected into the container as an environment variable:

```typescript
// In the container creation flow:
const apiKey = provisionContainerApiKey(db, instanceId, tenantId, workload.name, scopes);

// Added to the container's env:
env: {
  ...workload.entrypoint.env,
  BOILERHOUSE_API_KEY: apiKey,
  BOILERHOUSE_API_URL: `http://${apiHost}:${apiPort}`,
}
```

### Revocation (on destroy)

**Modified: instance destroy flow**

When an instance is destroyed (any path — manual, idle timeout, pool drain):

```typescript
db.delete(containerApiKeys)
  .where(eq(containerApiKeys.instanceId, instanceId))
  .run();
```

This is a single DELETE — immediate, no grace period. Any in-flight API call using the
key will get 401 on the next request.

### Expiry (background cleanup)

Keys have a hard `expiresAt` TTL (default 24h). Even if the instance destroy event is
missed (crash, orphan), the key becomes invalid after expiry.

A periodic cleanup job (every hour) deletes expired keys:

```typescript
db.delete(containerApiKeys)
  .where(lte(containerApiKeys.expiresAt, new Date()))
  .run();
```

---

## Auth Middleware Changes

### Modified: `apps/api/src/routes/auth-middleware.ts`

The current middleware checks a single global `apiKey`. Extend it to also check
container-scoped keys:

```typescript
export function authMiddleware(globalApiKey: string | undefined, db: DrizzleDb) {
  return new Elysia({ name: "auth-middleware" })
    .onRequest(({ request, set, store }) => {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/api/v1/")) return;
      if (url.pathname === "/api/v1/health") return;

      const authHeader = request.headers.get("Authorization");
      const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

      if (!token) {
        set.status = 401;
        return unauthorizedResponse();
      }

      // Check global admin key first
      if (globalApiKey && token === globalApiKey) {
        // Admin key — full access, no scope restrictions
        store.authContext = { type: "admin" } as AuthContext;
        return;
      }

      // Check container-scoped key
      const keyRow = db
        .select()
        .from(containerApiKeys)
        .where(eq(containerApiKeys.key, token))
        .get();

      if (!keyRow) {
        set.status = 401;
        return unauthorizedResponse();
      }

      // Check expiry
      if (keyRow.expiresAt <= new Date()) {
        set.status = 401;
        return unauthorizedResponse();
      }

      // Store auth context for downstream scope checks
      store.authContext = {
        type: "container",
        tenantId: keyRow.tenantId,
        workload: keyRow.workload,
        instanceId: keyRow.instanceId,
        scopes: keyRow.scopes as ApiKeyScope[],
      } as AuthContext;
    })
    .as("scoped");
}
```

### Auth context type

```typescript
export type AuthContext =
  | { type: "admin" }
  | {
      type: "container";
      tenantId: TenantId;
      workload: string;
      instanceId: InstanceId;
      scopes: ApiKeyScope[];
    };
```

### Scope checking helper

Routes that require specific scopes use a helper:

```typescript
export function requireScope(authContext: AuthContext, scope: ApiKeyScope): boolean {
  if (authContext.type === "admin") return true;
  return authContext.scopes.includes(scope);
}

// Usage in a route handler:
if (!requireScope(store.authContext, "agent-triggers:write")) {
  set.status = 403;
  return { error: "Insufficient scope: agent-triggers:write required" };
}
```

### Tenant isolation enforcement

Container-scoped keys can only access their own tenant's resources. Routes enforce this:

```typescript
// In agent-triggers route:
if (store.authContext.type === "container") {
  if (params.tenantId !== store.authContext.tenantId) {
    set.status = 403;
    return { error: "Cannot access another tenant's resources" };
  }
}
```

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `packages/db/src/schema.ts` | Modify | Add `containerApiKeys` table |
| `packages/db/drizzle/0017_container_api_keys.sql` | Create | Migration |
| `packages/db/src/index.ts` | Modify | Export table + types |
| `packages/core/src/types.ts` | Modify | Add `ApiKeyScope` type |
| `apps/api/src/routes/auth-middleware.ts` | Modify | Dual-path auth (global + container-scoped) |
| `apps/api/src/routes/auth-middleware.test.ts` | Modify | Tests for scoped auth |
| `apps/api/src/container-api-keys.ts` | Create | `provisionContainerApiKey`, `revokeContainerApiKey`, cleanup |
| `apps/api/src/container-api-keys.test.ts` | Create | Provisioning/revocation/expiry tests |
| `apps/api/src/bootstrap.ts` | Modify | Wire provisioning into claim flow, inject env vars |
| `packages/core/src/workload.ts` (or types) | Modify | Add `apiAccess` field to workload schema |

---

## Sequencing

1. `containerApiKeys` table + migration. No behaviour change.
2. `ApiKeyScope` type in core. Pure types.
3. `container-api-keys.ts` — provision/revoke/cleanup functions + tests.
4. Auth middleware update — dual-path auth + scope checking.
5. Wire provisioning into the claim flow + env var injection.
6. Add `apiAccess` field to workload schema.
7. Periodic expired key cleanup job.

Items 1-2 can be done in parallel. Items 3-4 can be done in parallel. 5 depends on 3+4.

---

## Security Considerations

**Key entropy:** 32 random bytes (256 bits) — same as the global API key. Generated
via `crypto.randomBytes`, not `Math.random`.

**Storage:** Keys are stored as plaintext hex in SQLite. This is acceptable because:
- The DB file is on the same machine as the containers that hold the keys.
- If an attacker has DB read access, they already have more powerful access vectors.
- Hashing keys would require a lookup-by-hash pattern that SQLite doesn't index well
  for constant-time comparison. If this becomes a concern, hash + salt and use a
  timing-safe comparison.

**TTL:** Default 24h. Containers that run longer than 24h will lose API access. The
TTL should be refreshed periodically — either:
- (Simple) Set TTL to match the workload's max session duration.
- (Better) A heartbeat from the container that extends the TTL. But this adds
  complexity — start with a generous fixed TTL and revisit.

**Scope escalation:** Container keys cannot:
- Access admin-only endpoints (workload CRUD, trigger CRUD, system config).
- Access other tenants' data.
- Modify their own scopes.
- Create new API keys.

**Audit:** Every API call with a container key should log `{ instanceId, tenantId, scope }`
via the existing `activityLog`. This gives operators visibility into what agents are doing.

---

## How Other Features Use This

### Wake-up tasks (agent-triggers)

The agent-triggers route checks:
```typescript
requireScope(store.authContext, "agent-triggers:write")
// + tenant isolation: authContext.tenantId === params.tenantId
```

### GitHub Issues skill

If proxied through Boilerhouse (rather than direct `gh` CLI), the skill route checks:
```typescript
requireScope(store.authContext, "issues:write")
```

### Future: agent reading its own secrets

```typescript
requireScope(store.authContext, "secrets:read")
// + tenant isolation
```

### Future: agent querying workload status

```typescript
requireScope(store.authContext, "workloads:read")
```

---

## Example: Full Lifecycle

```
1. User sends message in Telegram
2. Trigger adapter dispatches to workload "assistant"
3. TenantManager.claim("tg-12345", "assistant") → instance i-abc
4. provisionContainerApiKey(db, "i-abc", "tg-12345", "assistant", defaultScopes)
   → key = "a1b2c3..."
5. Container i-abc starts with:
   BOILERHOUSE_API_KEY=a1b2c3...
   BOILERHOUSE_API_URL=http://10.0.0.1:3000

6. Agent processes user message
7. Agent wants to set a reminder:
   POST http://10.0.0.1:3000/api/v1/agent-triggers
   Authorization: Bearer a1b2c3...
   { "type": "one-shot", "runAt": "...", ... }

8. authMiddleware resolves key → container scope
   → checks "agent-triggers:write" ∈ scopes ✓
   → checks tenantId matches ✓
   → 201 Created

9. User goes idle, container destroyed
10. DELETE FROM container_api_keys WHERE instance_id = 'i-abc'
    → key is immediately invalid
```

---

## Open Questions

- **Key rotation for long-lived containers:** Containers running for days (e.g. always-on
  agents) will hit the 24h TTL. Options: (a) set TTL to match workload idle timeout,
  (b) the container calls a refresh endpoint before expiry, (c) the API auto-extends on
  each authenticated request. Leaning toward (c) — add a `lastUsedAt` column and extend
  `expiresAt` on each successful auth check. Simple, no container changes needed.
- **Scope per-trigger vs per-workload:** Current design scopes per-workload. If different
  tenants on the same workload need different scopes, we'd need per-tenant scope overrides.
  Start without this — all containers of a workload get the same scopes.
- **Key injection timing:** The key must be available before the container's entrypoint
  runs. Since it's an env var set at container creation time, this is guaranteed. But if
  containers are reused from a pool (pre-warmed), the key must be injected at claim time,
  not at container creation. Verify the pool manager supports env var injection at claim.
