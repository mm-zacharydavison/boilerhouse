# Kadai Preset Actions — Design Spec

## Goal

Ship two one-command quickstarts: `bunx kadai run presets/claude-code` and `bunx kadai run presets/openclaw`. Each prompts for the minimum viable inputs (Telegram bot token, Anthropic API key, allowlist usernames), creates the necessary K8s Secrets, renders and applies the workload + pool + trigger YAMLs, and starts the dev server — all idempotent on re-run.

Replaces the TS-era preset scripts that were removed alongside the TypeScript code.

## Scope

- Two per-agent kadai action scripts and one shared helper library under `.kadai/actions/presets/`.
- Templatization of four existing YAMLs (`openclaw.yaml` for the gateway token; `claude-code-trigger.yaml` and `openclaw-trigger.yaml` for the allowlist).
- `.gitignore` entry for the render output dir.
- No Go changes; no CRD changes. Credential schema support already landed.

## Non-goals

- Multi-user Anthropic keys. The key is a single global Secret (`anthropic-api`) shared by all allowlisted users — tenant-scoped secrets are deferred to a later spec.
- Preset UI beyond stdin prompts. No web UI, no config file, no "wizard mode".
- Automated installation of `bun`, `kubectl`, `minikube`, `openssl`, `envsubst`, `docker`. Missing prereqs produce a one-line install hint and exit.
- Rotation workflows. Users rotate tokens by deleting the Secret and re-running the preset.
- Unit tests for the shell scripts. Verification is manual + optional template-render dry-run.

## Architecture

```
bunx kadai run presets/claude-code   (or presets/openclaw)
   │
   ├─ Prereq checks:  docker, openssl, kubectl, envsubst
   │
   ├─ Ensure minikube is up  (delegates to .kadai/actions/minikube.sh)
   │
   ├─ Prompts (skipped if the backing Secret already exists):
   │     - TELEGRAM_BOT_TOKEN       (masked)
   │     - ANTHROPIC_API_KEY        (masked)
   │     - TELEGRAM_ALLOWLIST       (comma-separated usernames, always re-prompted)
   │
   ├─ Token load / generate:
   │     - If openclaw-gateway-token Secret exists → read its value into $OPENCLAW_GATEWAY_TOKEN
   │     - Else → generate via openssl rand -hex 24
   │
   ├─ Create K8s Secrets in `boilerhouse` ns (skip if present):
   │     - telegram-bot-token (key=token)
   │     - anthropic-api      (key=key)
   │     - openclaw-gateway-token (key=token)   [openclaw only]
   │
   ├─ Stage manifests:
   │     envsubst < workloads/<file> > .boilerhouse-preset/workloads/<file>
   │
   ├─ kubectl apply -f .boilerhouse-preset/workloads/
   │
   └─ exec .kadai/actions/dev.sh
```

K8s is the source of truth — re-running the preset reuses existing Secret values, keeping the container env, Secret data, and trigger-side Bearer auth in sync. Non-secret inputs (allowlist) are re-prompted each run since they are not sensitive and re-apply is cheap.

## File layout

```
.kadai/actions/
  dev.sh                   (exists, unchanged)
  minikube.sh              (exists, unchanged)
  nuke.sh                  (exists, unchanged)
  setup.sh                 (exists, unchanged)
  presets/                 ← new
    _lib.sh                ← shared helpers
    claude-code.sh         ← per-agent preset
    openclaw.sh            ← per-agent preset

workloads/
  claude-code.yaml             unchanged (uses credentials secretKeyRef already)
  claude-code-pool.yaml        unchanged
  claude-code-trigger.yaml     modified: tenantIds → ${TELEGRAM_ALLOWLIST_JSON}
  openclaw.yaml                modified: OPENCLAW_GATEWAY_TOKEN literal → "${OPENCLAW_GATEWAY_TOKEN}"
  openclaw-pool.yaml           unchanged
  openclaw-trigger.yaml        modified: tenantIds → ${TELEGRAM_ALLOWLIST_JSON}

.gitignore                     adds `.boilerhouse-preset/`
.boilerhouse-preset/           gitignored, populated at preset time
  workloads/                   rendered output
```

## Templatization

### Allowlist — both `*-trigger.yaml` files

Before:
```yaml
guards:
  - type: allowlist
    config:
      tenantIds:
        - tg-alice
        - tg-bob
      denyMessage: "You are not authorized to use this agent."
```

After:
```yaml
guards:
  - type: allowlist
    config:
      tenantIds: ${TELEGRAM_ALLOWLIST_JSON}
      denyMessage: "You are not authorized to use this agent."
```

Preset builds `TELEGRAM_ALLOWLIST_JSON='["tg-alice","tg-bob"]'` from the comma-separated input. YAML accepts inline JSON flow syntax, so the rendered `tenantIds: ["tg-alice","tg-bob"]` parses correctly.

The header-comment block in each trigger YAML (prereq notes) stays.

### Openclaw gateway token — `workloads/openclaw.yaml` only

Before:
```yaml
entrypoint:
  env:
    OPENCLAW_GATEWAY_TOKEN: "73307c8aab2b025f959a53f5095c0addec0be76fe4b5d470"
```

After:
```yaml
entrypoint:
  env:
    OPENCLAW_GATEWAY_TOKEN: "${OPENCLAW_GATEWAY_TOKEN}"
```

The committed value becomes a placeholder. Preset substitutes either a regenerated-on-first-run value or the existing Secret's value.

### Credential Secret references

The `valueFrom.secretKeyRef` on `credentials` already resolves from K8s Secrets at pod creation (landed in the credential-schema merge). The preset just has to ensure the referenced Secrets exist (`anthropic-api` for claude-code and openclaw; `telegram-bot-token` used by the telegram adapter). No templating of the workload YAMLs' credentials blocks.

## Shared helpers — `_lib.sh`

Each helper is idempotent. All accept bash strict mode (`set -euo pipefail`).

```bash
# Prereq checks — fail fast with a specific install hint.
ensure_cmd <name> <install-hint>          # e.g. ensure_cmd openssl "brew install openssl"
ensure_docker_running                     # docker info must succeed
ensure_minikube_up                        # exec bash .kadai/actions/minikube.sh if not running

# Secrets.
# $1 = secret name, $2 = key, $3 = name of shell var to populate, $4 = prompt text
ensure_secret <name> <key> <var> <prompt>            # prompts masked; reads back existing value if Secret exists
ensure_secret_generated <name> <key> <var>           # no prompt; generates with openssl rand -hex 24 if absent; reads back if present

# Non-secret inputs.
prompt_value     <var> <prompt> [<default>]
prompt_allowlist <var> <prompt>                      # reads comma-separated, sets <var>_JSON='["a","b"]'

# Rendering and apply.
stage_manifests <src-dir> <dst-dir> <file>...        # envsubst into dst-dir; assert no ${} remain
apply_manifests <dir>                                 # kubectl -n boilerhouse apply -f <dir>/*.yaml

# Final.
exec_dev                                              # exec bash .kadai/actions/dev.sh
```

### Per-agent scripts

`.kadai/actions/presets/claude-code.sh` body (sketch):

```bash
#!/usr/bin/env bash
set -euo pipefail

# kadai:name Claude Code preset
# kadai:description One-command Telegram-driven Claude Code agent with allowlist auth.

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
source "$HERE/_lib.sh"

ensure_cmd docker     "brew install --cask docker"
ensure_cmd kubectl    "brew install kubernetes-cli"
ensure_cmd envsubst   "brew install gettext && brew link --force gettext"
ensure_cmd openssl    "(ships with macOS)"
ensure_docker_running
ensure_minikube_up

ensure_secret telegram-bot-token token TELEGRAM_BOT_TOKEN \
  "Telegram bot token (from @BotFather)"
ensure_secret anthropic-api       key   ANTHROPIC_API_KEY \
  "Anthropic API key (sk-ant-...)"

prompt_allowlist TELEGRAM_ALLOWLIST \
  "Telegram usernames allowed to use this agent (comma-separated, e.g. alice,bob)"

# Preset-internal: build tg-prefixed JSON from the bare usernames.
TELEGRAM_ALLOWLIST_JSON="$(to_tg_allowlist_json "$TELEGRAM_ALLOWLIST")"
export TELEGRAM_ALLOWLIST_JSON

mkdir -p "$REPO/.boilerhouse-preset/workloads"
stage_manifests "$REPO/workloads" "$REPO/.boilerhouse-preset/workloads" \
  claude-code.yaml claude-code-pool.yaml claude-code-trigger.yaml

apply_manifests "$REPO/.boilerhouse-preset/workloads"
exec_dev
```

`.kadai/actions/presets/openclaw.sh` differs from the above in:

- Adds `ensure_secret_generated openclaw-gateway-token token OPENCLAW_GATEWAY_TOKEN` before the `stage_manifests` call.
- Calls `export OPENCLAW_GATEWAY_TOKEN` after.
- Stages `openclaw.yaml openclaw-pool.yaml openclaw-trigger.yaml`.

`to_tg_allowlist_json` is a tiny helper inside `_lib.sh`: splits on `,`, trims whitespace, prepends `tg-` to each bare username, emits JSON. Already-prefixed input (`tg-alice`) is kept as-is.

## Idempotency

Running the preset twice produces the same cluster state without re-prompting for secrets:

- **Secret exists** → `kubectl get secret -n boilerhouse <name> -o jsonpath='{.data.<key>}' | base64 --decode` populates the shell var. No prompt, no overwrite.
- **Secret absent** → prompt masked; create via `kubectl create secret generic`.
- **Allowlist** — always re-prompted (not secret).
- **Workload / Pool / Trigger CRs** — `kubectl apply` reconciles without error.
- **Generated gateway token** — once in the Secret, re-runs reuse the literal value; templated into both the workload's env and the trigger's `gatewayTokenSecretRef`-backed Bearer header.

Rotation workflow (documented in script output, not automated):
```
kubectl -n boilerhouse delete secret <name>
bunx kadai run presets/<agent>
```

## Error handling

Each failure mode prints a one-line actionable message before exiting non-zero.

- **Prereq command missing** — `ensure_cmd` prints `<name> not installed. Install with: <hint>`.
- **Docker daemon down** — prints `Docker daemon is not running. Start Docker Desktop and retry.`.
- **Minikube bootstrap fails** — propagates the underlying `minikube.sh` error unchanged; preset exits without touching K8s.
- **Secret read failure** (RBAC, API unreachable) — error + exit. Do not proceed to apply.
- **Empty input on masked prompt** — loop until non-empty. Tokens are required.
- **Empty allowlist** — error, re-prompt. Applying an empty allowlist locks everyone out.
- **Rendered YAML contains unresolved `${...}`** — `stage_manifests` greps the rendered output; any unresolved placeholder aborts with the template path and missing variable name.
- **`kubectl apply` failure** — print kubectl's error, exit. Apply is idempotent so re-runs are safe.

## Testing

Primarily manual; the scripts are shell orchestration without branching business logic.

**Manual smoke tests** (per agent):

1. Fresh state:
   ```bash
   bunx kadai run nuke
   minikube delete -p boilerhouse
   ```
2. First run: `bunx kadai run presets/claude-code`. Provide real tokens + a Telegram username owned by you. Verify the bot replies to a test message.
3. Idempotent re-run: `bunx kadai run presets/claude-code` with no changes. Confirm the script reuses the existing Secrets (prints "reusing") and restarts `dev.sh`.
4. Rotation: `kubectl -n boilerhouse delete secret anthropic-api` and re-run. Confirm only the Anthropic prompt reappears.
5. Repeat for `presets/openclaw`.

**Optional template-render test** — cheap pre-flight:

```bash
TELEGRAM_ALLOWLIST_JSON='["tg-test"]' OPENCLAW_GATEWAY_TOKEN=abcdef \
  envsubst < workloads/openclaw-trigger.yaml | kubectl apply --dry-run=client --validate=false -f -
```

Same for `openclaw.yaml` and the claude-code variants (which don't need `OPENCLAW_GATEWAY_TOKEN`).

## Risks

- **Two sources of truth for the openclaw gateway token.** The workload container reads `$OPENCLAW_GATEWAY_TOKEN` from its env; the trigger gateway reads from the `openclaw-gateway-token` Secret. Both come from the same preset-managed variable per run, so they stay in sync — but a user editing one without the other would break trigger auth. Mitigation: the generated-token flow keeps this hidden from users; rotating is a documented delete-Secret-then-re-run.
- **`envsubst` blindness.** `envsubst` substitutes any `${VAR}` it finds, including accidental ones in YAML comments or values. Mitigation: the unresolved-placeholder grep after staging catches *missed* substitutions; a false substitution into an unrelated `${...}` would require a committed YAML to contain a literal `${SOMETHING}` outside of templating intent, which currently no file does.
- **Minikube auto-bootstrap** on first run downloads the VM image (multi-GB) silently. Mitigation: `minikube.sh`'s existing output is not suppressed; the user sees it.
- **Committed `OPENCLAW_GATEWAY_TOKEN` literal has to be removed.** The committed `73307c8...` token in `workloads/openclaw.yaml` is replaced by the `${}` placeholder in this change — any external user who was applying that YAML directly will break until they render it through envsubst. Mitigated by a header-comment update pointing them at `bunx kadai run presets/openclaw`.
