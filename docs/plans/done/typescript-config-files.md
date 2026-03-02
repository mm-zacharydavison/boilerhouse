# Plan: TypeScript Workload Config Files

Replace TOML workload definitions with TypeScript files using `defineWorkload()`.

## Motivation

TOML's `[[array.of.tables]]` syntax forces related data to scatter across
disconnected sections. TypeScript config files solve this and unlock future
capabilities (user-defined functions, computed values, shared config fragments).

## Example

```ts
// workloads/openclaw.ts
import { defineWorkload, secret } from "@boilerhouse/core";

export default defineWorkload({
  name: "openclaw",
  version: "0.1.0",
  image: { ref: "localhost/openclaw:latest" },
  resources: { vcpus: 2, memory_mb: 2048, disk_gb: 10 },
  network: {
    access: "restricted",
    allowlist: ["api.anthropic.com", "api.openai.com", "registry.npmjs.org"],
    expose: [{ guest: 18789, host_range: [30000, 30099] }],
    credentials: [{
      domain: "api.anthropic.com",
      headers: { "x-api-key": secret("ANTHROPIC_API_KEY") },
    }],
  },
  // ...
});
```

## Changes

### Phase 1: Core — `defineWorkload()` and `secret()`

**`packages/core/src/workload.ts`**

1. Add a `SecretRef` branded type and `secret()` factory:

   ```ts
   const SECRET_BRAND = Symbol("SecretRef");

   export interface SecretRef {
     [SECRET_BRAND]: true;
     name: string;
   }

   export function secret(name: string): SecretRef {
     return { [SECRET_BRAND]: true, name };
   }

   export function isSecretRef(value: unknown): value is SecretRef {
     return typeof value === "object" && value !== null && SECRET_BRAND in value;
   }
   ```

2. Add `defineWorkload()` — an identity function with a typed signature.
   The input type should be a "user-facing" variant of `Workload` where:
   - `workload.name` and `workload.version` are lifted to top-level `name`
     and `version` fields (less nesting for the common case)
   - credential header values accept `string | SecretRef`
   - defaults are applied (same ones TypeBox currently applies)

   ```ts
   export interface WorkloadConfig {
     name: string;
     version: string;
     image: { ref?: string; dockerfile?: string };
     resources: { vcpus: number; memory_mb: number; disk_gb?: number };
     network?: { /* same shape, but headers accept SecretRef */ };
     // ... rest of fields without the outer `workload` wrapper
   }

   export function defineWorkload(config: WorkloadConfig): WorkloadConfig {
     return config;
   }
   ```

3. Add `resolveWorkloadConfig(config: WorkloadConfig): Workload` that:
   - Wraps `name`/`version` into `{ workload: { name, version } }` if using
     the flattened input shape
   - Serializes `SecretRef` values to `"${secret:NAME}"` strings for storage
   - Applies defaults (disk_gb, network.access, idle.action)
   - Runs the existing mutual-exclusivity checks
   - Validates against `WorkloadSchema` via TypeBox
   - Returns the canonical `Workload` type (same shape stored in DB today)

4. Keep `parseWorkload(toml: string)` temporarily for backward compat during
   migration. Remove it and `smol-toml` in Phase 4.

5. Export `secret`, `isSecretRef`, `SecretRef`, `defineWorkload`,
   `WorkloadConfig`, `resolveWorkloadConfig` from `packages/core/src/index.ts`.

**Tests (`packages/core/src/workload.test.ts`)**

- Add tests for `defineWorkload()` + `resolveWorkloadConfig()` covering:
  - Minimal config → produces valid `Workload`
  - SecretRef serialization in credential headers
  - Default application (disk_gb, network.access, idle.action)
  - Mutual exclusivity errors (image.ref + dockerfile, both health probes)
  - Credential domain allowlist validation

### Phase 2: Workload Loader — Import `.ts` Files

**`packages/db/src/workload-loader.ts`**

1. Change glob from `**/*.toml` to `**/*.ts`.
2. Replace `readFileSync` + `parseWorkload` with dynamic `import()`:

   ```ts
   const mod = await import(fullPath);
   const config = mod.default as WorkloadConfig;
   const workload = resolveWorkloadConfig(config);
   ```

3. The function becomes `async` (it already returns a result object, callers
   just need to await it).

**`apps/api/src/server.ts`**

- `await` the now-async `loadWorkloadsFromDir()` call.

**Tests (`packages/db/src/workload-loader.test.ts`)**

- Change inline TOML strings to temp `.ts` files written to a temp dir:

  ```ts
  const content = `
  import { defineWorkload } from "@boilerhouse/core";
  export default defineWorkload({
    name: "test-app",
    version: "1.0.0",
    image: { ref: "alpine:latest" },
    resources: { vcpus: 1, memory_mb: 512 },
  });
  `;
  writeFileSync(join(tmpDir, "test.ts"), content);
  ```

- Update assertions for async behavior.

### Phase 3: API Route — Accept JSON

**`apps/api/src/routes/workloads.ts`**

The `POST /workloads` endpoint currently accepts a TOML text body. Change it to
accept JSON (a serialized `Workload` object):

```ts
.post("/workloads", async ({ request, set }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    set.status = 400;
    return { error: "Invalid JSON" };
  }

  // Validate against WorkloadSchema directly
  Value.Default(WorkloadSchema, body);
  // ... same validation as before, but no TOML parsing step
});
```

This is a clean break — the API accepts the canonical `Workload` shape as JSON.
File-based loading (Phase 2) handles the ergonomic TS config.
The API is for programmatic registration, not human authoring.

**Tests (`apps/api/src/routes/workloads.test.ts`)**

- Replace `VALID_TOML` string with a JSON object.
- Change `content-type` from `text/plain` to `application/json`.
- Update invalid-input tests (invalid JSON instead of invalid TOML).

### Phase 4: Convert All Fixtures and Dev Workloads

**Dev workloads (`workloads/*.toml` → `workloads/*.ts`)**

Convert each file. Example for `workloads/minimal.toml`:

```ts
import { defineWorkload } from "@boilerhouse/core";

export default defineWorkload({
  name: "minimal",
  version: "0.1.0",
  image: { ref: "docker.io/library/alpine:3.21" },
  resources: { vcpus: 1, memory_mb: 256, disk_gb: 1 },
});
```

**E2E fixtures (`apps/api/src/e2e/fixtures/*.toml` → `*.ts`)**

Convert all 8 fixture files to `.ts` equivalents.

**E2E test matrix (`apps/api/src/e2e/runtime-matrix.ts`)**

- Update all `fixturePath()` calls from `.toml` to `.ts` extensions.

**E2E helpers (`apps/api/src/e2e/e2e-helpers.ts`)**

- `readFixture()` changes from reading text to importing and serializing:

  ```ts
  export async function readFixture(path: string): Promise<Workload> {
    const mod = await import(path);
    return resolveWorkloadConfig(mod.default);
  }
  ```

- All E2E test call sites that do `api(server, "POST", "/api/v1/workloads", toml)`
  change to send JSON:

  ```ts
  const workload = await readFixture(rt.workloadFixtures.httpserver);
  const res = await api(server, "POST", "/api/v1/workloads", JSON.stringify(workload));
  ```

  Or update `api()` helper to accept objects and serialize automatically.

**Workload fixture validation (`workloads/workloads.test.ts`)**

- Change glob from `*.toml` to `*.ts`, use `import()` instead of
  `Bun.file().text()`.

**Delete old `.toml` files** after all conversions verified.

### Phase 5: Cleanup

1. Remove `smol-toml` from `packages/core/package.json`.
2. Remove `parseWorkload()` from `packages/core/src/workload.ts`.
3. Remove `WorkloadParseError` (replace with standard validation errors from
   `resolveWorkloadConfig`).
4. Remove the `WorkloadParseError` handler from
   `apps/api/src/routes/errors.ts`.
5. Update `packages/core/src/index.ts` exports — remove TOML-related exports.
6. Run `bun install` to clean lockfile.

## Files Touched

| File                                          | Change                                       |
|-----------------------------------------------|----------------------------------------------|
| `packages/core/src/workload.ts`               | Add defineWorkload, secret, resolve; rm TOML |
| `packages/core/src/index.ts`                  | Update exports                               |
| `packages/core/package.json`                  | Remove smol-toml                             |
| `packages/core/src/workload.test.ts`          | Rewrite for TS config                        |
| `packages/db/src/workload-loader.ts`          | Glob .ts, dynamic import, async              |
| `packages/db/src/workload-loader.test.ts`     | Temp .ts files instead of TOML strings       |
| `apps/api/src/routes/workloads.ts`            | Accept JSON body                             |
| `apps/api/src/routes/workloads.test.ts`       | JSON fixtures instead of TOML strings        |
| `apps/api/src/routes/errors.ts`               | Remove WorkloadParseError handler            |
| `apps/api/src/server.ts`                      | Await async loader                           |
| `apps/api/src/e2e/e2e-helpers.ts`             | Import-based readFixture                     |
| `apps/api/src/e2e/runtime-matrix.ts`          | .ts fixture paths                            |
| `apps/api/src/e2e/fixtures/*.toml`            | Delete (replaced by .ts)                     |
| `apps/api/src/e2e/fixtures/*.ts`              | New fixture files (8 files)                  |
| `workloads/*.toml`                            | Delete (replaced by .ts)                     |
| `workloads/*.ts`                              | New workload files (3 files)                 |
| `workloads/workloads.test.ts`                 | Update glob + import                         |

## Open Questions

- **Flattened vs nested `workload` key:** The example above lifts `name` and
  `version` to the top level of `WorkloadConfig`. The DB stores the nested
  `{ workload: { name, version } }` shape. `resolveWorkloadConfig` bridges
  the two. Alternatively, keep the nested shape for consistency and simplicity.
- **`secret()` return type in headers:** `CredentialRule.headers` is currently
  `Record<string, string>`. With `SecretRef`, it becomes
  `Record<string, string | SecretRef>`. This needs a separate "input" type
  vs the "resolved" type stored in DB (where SecretRefs are serialized to
  `"${secret:NAME}"` strings). The resolved type stays `Record<string, string>`.
