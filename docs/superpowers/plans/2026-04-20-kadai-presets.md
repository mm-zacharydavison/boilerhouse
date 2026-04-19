# Kadai Preset Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `bunx kadai run presets/claude-code` and `bunx kadai run presets/openclaw` — one-command quickstarts that prompt for minimum inputs, create K8s Secrets, render workload/pool/trigger YAMLs, apply them, and start the dev server.

**Architecture:** Two per-agent Bash scripts under `.kadai/actions/presets/`, plus a shared `_lib.sh`. YAMLs become envsubst templates for the allowlist and the openclaw gateway token; rendered files land in a gitignored `.boilerhouse-preset/workloads/` staging dir.

**Tech Stack:** Bash 4+, kadai (script runner), `envsubst` (from gettext), `kubectl`, `openssl`, `docker`, `minikube`. No Go changes.

---

## Preconditions

- [ ] **Confirm clean working tree.**
  ```bash
  cd /Users/z/work/boilerhouse
  git status
  ```
  Expected: unrelated uncommitted changes (`claim_controller.go`, resilience work) are fine but there should be no edits to files this plan touches (`workloads/openclaw.yaml`, `workloads/*-trigger.yaml`, `.kadai/actions/`, `.gitignore`).

- [ ] **Confirm tooling present.**
  ```bash
  which envsubst openssl kubectl docker minikube
  ```
  Expected: all five resolve. These are what the preset scripts will call; developing without them is painful.

- [ ] **Confirm the current committed `OPENCLAW_GATEWAY_TOKEN` literal.** Keep it handy — Task 2 replaces it with a placeholder.
  ```bash
  grep 'OPENCLAW_GATEWAY_TOKEN:' workloads/openclaw.yaml
  ```
  Expected output: `          OPENCLAW_GATEWAY_TOKEN: "73307c8aab2b025f959a53f5095c0addec0be76fe4b5d470"`

---

## Task 1: Gitignore the preset staging dir

Single-file change. Must land before anything else writes to `.boilerhouse-preset/`.

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Add the ignore rule.**

Open `.gitignore` and add `.boilerhouse-preset/` on its own line. The file already has a consistent one-entry-per-line style; just append:

```
.boilerhouse-preset/
```

- [ ] **Step 2: Verify the rule works.**

```bash
cd /Users/z/work/boilerhouse
mkdir -p .boilerhouse-preset/workloads
touch .boilerhouse-preset/workloads/test.yaml
git check-ignore .boilerhouse-preset/workloads/test.yaml
rm -rf .boilerhouse-preset
```

Expected: `git check-ignore` prints `.boilerhouse-preset/workloads/test.yaml` (exit 0).

- [ ] **Step 3: Commit.**

```bash
git add .gitignore
git commit -m "chore: gitignore .boilerhouse-preset/ staging dir"
```

---

## Task 2: Templatize the three workload YAMLs

Replace the committed literal gateway token with a placeholder, and replace the hard-coded allowlist arrays with a JSON-flow placeholder.

**Files:**
- Modify: `workloads/openclaw.yaml`
- Modify: `workloads/claude-code-trigger.yaml`
- Modify: `workloads/openclaw-trigger.yaml`

- [ ] **Step 1: Templatize `workloads/openclaw.yaml`.**

Find the line `OPENCLAW_GATEWAY_TOKEN: "73307c8aab2b025f959a53f5095c0addec0be76fe4b5d470"` inside `entrypoint.env` and change to:

```yaml
      OPENCLAW_GATEWAY_TOKEN: "${OPENCLAW_GATEWAY_TOKEN}"
```

Do not change any other field.

- [ ] **Step 2: Templatize `workloads/openclaw-trigger.yaml`.**

Find the `guards` block and replace the multi-line list form with JSON-flow placeholder. Before:

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

Leave every other field and every comment unchanged.

- [ ] **Step 3: Templatize `workloads/claude-code-trigger.yaml`.**

Same edit as Step 2, in `workloads/claude-code-trigger.yaml`. After:

```yaml
  guards:
    - type: allowlist
      config:
        tenantIds: ${TELEGRAM_ALLOWLIST_JSON}
        denyMessage: "You are not authorized to use this agent."
```

- [ ] **Step 4: Verify each rendered template parses.**

```bash
cd /Users/z/work/boilerhouse
TELEGRAM_ALLOWLIST_JSON='["tg-test"]' OPENCLAW_GATEWAY_TOKEN=deadbeef \
  envsubst < workloads/openclaw.yaml \
  | python3 -c "import sys,yaml; yaml.safe_load(sys.stdin)" && echo openclaw-OK

TELEGRAM_ALLOWLIST_JSON='["tg-test"]' envsubst < workloads/openclaw-trigger.yaml \
  | python3 -c "import sys,yaml; yaml.safe_load(sys.stdin)" && echo trigger-openclaw-OK

TELEGRAM_ALLOWLIST_JSON='["tg-test"]' envsubst < workloads/claude-code-trigger.yaml \
  | python3 -c "import sys,yaml; yaml.safe_load(sys.stdin)" && echo trigger-cc-OK
```

Expected: three `*-OK` lines. If `python3` isn't available, swap for any YAML parser (e.g. `yq e . -`).

- [ ] **Step 5: Verify rendered tenantIds is a real YAML array.**

```bash
TELEGRAM_ALLOWLIST_JSON='["tg-alice","tg-bob"]' envsubst < workloads/openclaw-trigger.yaml \
  | python3 -c "import sys,yaml; d=yaml.safe_load(sys.stdin); ids=d['spec']['guards'][0]['config']['tenantIds']; print(ids); assert ids==['tg-alice','tg-bob']"
```

Expected: prints `['tg-alice', 'tg-bob']` with no assertion error.

- [ ] **Step 6: Commit.**

```bash
git add workloads/openclaw.yaml workloads/claude-code-trigger.yaml workloads/openclaw-trigger.yaml
git commit -m "refactor(workloads): templatize allowlist + openclaw gateway token"
```

---

## Task 3: Shared preset helpers (`_lib.sh`)

All the reusable Bash functions the two preset scripts call. Pure library — no side effects when sourced.

**Files:**
- Create: `.kadai/actions/presets/_lib.sh`

- [ ] **Step 1: Create the directory and write the helper library.**

```bash
cd /Users/z/work/boilerhouse
mkdir -p .kadai/actions/presets
```

Write `.kadai/actions/presets/_lib.sh`:

```bash
#!/usr/bin/env bash
# Shared helpers for boilerhouse preset actions.
# Source this file — do not execute directly.

# Callers must have already set: set -euo pipefail

PRESET_NS="boilerhouse"
PRESET_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PRESET_STAGE_DIR="$PRESET_REPO/.boilerhouse-preset/workloads"

# ── Prereq checks ────────────────────────────────────────────────────────────

ensure_cmd() {
  local name="$1" hint="$2"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "Error: $name not installed."
    echo "  Install with: $hint"
    exit 1
  fi
}

ensure_docker_running() {
  if ! docker info >/dev/null 2>&1; then
    echo "Error: Docker daemon is not running."
    echo "  Start Docker Desktop and retry."
    exit 1
  fi
}

ensure_minikube_up() {
  local profile="boilerhouse"
  if minikube status -p "$profile" >/dev/null 2>&1; then
    return 0
  fi
  echo "minikube profile '$profile' not running — bootstrapping..."
  exec bash "$PRESET_REPO/.kadai/actions/minikube.sh"
  # NB: exec does not return; the minikube action takes over. The preset's
  # caller re-runs the preset after minikube is up. If bootstrapping inline
  # here (without exec) is preferred, replace `exec` with plain `bash`.
}

# ── Secrets ──────────────────────────────────────────────────────────────────

# ensure_secret NAME KEY VAR PROMPT
# If Secret NAME exists in PRESET_NS, reads data[KEY], sets shell var VAR.
# Otherwise prompts the user (masked) for a non-empty value, creates the Secret,
# and sets VAR.
ensure_secret() {
  local name="$1" key="$2" var="$3" prompt="$4"
  if kubectl -n "$PRESET_NS" get secret "$name" >/dev/null 2>&1; then
    local b64
    b64="$(kubectl -n "$PRESET_NS" get secret "$name" -o jsonpath="{.data.$key}")"
    if [ -z "$b64" ]; then
      echo "Error: Secret $name exists but has no key $key."
      exit 1
    fi
    printf -v "$var" '%s' "$(printf '%s' "$b64" | base64 --decode)"
    echo "  reusing existing Secret $name"
    return 0
  fi

  local value=""
  while [ -z "$value" ]; do
    read -rs -p "  $prompt: " value
    echo
    if [ -z "$value" ]; then
      echo "  (required — cannot be empty)"
    fi
  done
  kubectl -n "$PRESET_NS" create secret generic "$name" \
    --from-literal="$key=$value" >/dev/null
  printf -v "$var" '%s' "$value"
  echo "  created Secret $name"
}

# ensure_secret_generated NAME KEY VAR
# Like ensure_secret but generates a random 48-hex-char token (openssl rand -hex 24)
# if the Secret is absent. No prompting.
ensure_secret_generated() {
  local name="$1" key="$2" var="$3"
  if kubectl -n "$PRESET_NS" get secret "$name" >/dev/null 2>&1; then
    local b64
    b64="$(kubectl -n "$PRESET_NS" get secret "$name" -o jsonpath="{.data.$key}")"
    if [ -z "$b64" ]; then
      echo "Error: Secret $name exists but has no key $key."
      exit 1
    fi
    printf -v "$var" '%s' "$(printf '%s' "$b64" | base64 --decode)"
    echo "  reusing existing Secret $name"
    return 0
  fi

  local value
  value="$(openssl rand -hex 24)"
  kubectl -n "$PRESET_NS" create secret generic "$name" \
    --from-literal="$key=$value" >/dev/null
  printf -v "$var" '%s' "$value"
  echo "  generated + created Secret $name"
}

# ── Non-secret inputs ────────────────────────────────────────────────────────

# prompt_allowlist VAR PROMPT
# Reads comma-separated usernames from stdin, trims whitespace, prefixes
# bare names with "tg-" (leaving already-prefixed names as-is), sets
# VAR_JSON='["tg-a","tg-b"]'. Loops until non-empty input.
prompt_allowlist() {
  local var="$1" prompt="$2"
  local raw=""
  while [ -z "$raw" ]; do
    read -r -p "  $prompt: " raw
    if [ -z "$raw" ]; then
      echo "  (required — cannot be empty)"
    fi
  done

  # Split on commas, trim, prefix, build JSON.
  local json="["
  local first=1
  local IFS=','
  read -ra parts <<<"$raw"
  for p in "${parts[@]}"; do
    local trimmed
    trimmed="$(echo "$p" | awk '{$1=$1};1')"
    [ -z "$trimmed" ] && continue
    if [[ "$trimmed" != tg-* ]]; then
      trimmed="tg-$trimmed"
    fi
    if [ $first -eq 1 ]; then
      first=0
    else
      json="$json,"
    fi
    json="$json\"$trimmed\""
  done
  json="$json]"

  printf -v "${var}_JSON" '%s' "$json"
}

# ── Template rendering and apply ────────────────────────────────────────────

# stage_manifests SRC_DIR DST_DIR FILE...
# envsubsts each FILE from SRC_DIR into DST_DIR. Aborts if any unresolved
# ${...} placeholder remains in the output.
stage_manifests() {
  local src="$1" dst="$2"
  shift 2
  mkdir -p "$dst"
  local f
  for f in "$@"; do
    envsubst <"$src/$f" >"$dst/$f"
    if grep -Eq '\$\{[A-Za-z_][A-Za-z_0-9]*\}' "$dst/$f"; then
      echo "Error: unresolved template placeholder in $dst/$f:"
      grep -nE '\$\{[A-Za-z_][A-Za-z_0-9]*\}' "$dst/$f"
      exit 1
    fi
  done
}

apply_manifests() {
  local dir="$1"
  kubectl -n "$PRESET_NS" apply -f "$dir"
}

exec_dev() {
  exec bash "$PRESET_REPO/.kadai/actions/dev.sh"
}
```

- [ ] **Step 2: Verify syntax with bash -n and shellcheck.**

```bash
cd /Users/z/work/boilerhouse
bash -n .kadai/actions/presets/_lib.sh && echo syntax-OK
command -v shellcheck >/dev/null && shellcheck -x .kadai/actions/presets/_lib.sh || echo "shellcheck not installed — skipping"
```

Expected: `syntax-OK`. If shellcheck is installed, no errors; warnings are acceptable.

- [ ] **Step 3: Verify `prompt_allowlist` function produces correct JSON.**

```bash
cd /Users/z/work/boilerhouse
bash -c '
set -euo pipefail
source .kadai/actions/presets/_lib.sh
# Simulate user input:
echo "alice, bob ,tg-charlie" | { prompt_allowlist FOO "Test"; echo "$FOO_JSON"; }
'
```

Expected output ends with `["tg-alice","tg-bob","tg-charlie"]`.

- [ ] **Step 4: Commit.**

```bash
git add .kadai/actions/presets/_lib.sh
git commit -m "feat(kadai): preset helper library"
```

---

## Task 4: Claude-code preset script

**Files:**
- Create: `.kadai/actions/presets/claude-code.sh`

- [ ] **Step 1: Write the script.**

Create `.kadai/actions/presets/claude-code.sh`:

```bash
#!/bin/bash
# kadai:name Claude Code preset
# kadai:emoji 💻
# kadai:description One-command Telegram-driven Claude Code agent with allowlist auth.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./_lib.sh
source "$HERE/_lib.sh"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║     Boilerhouse: Claude Code preset       ║"
echo "╚══════════════════════════════════════════╝"
echo ""

echo "Prerequisites:"
ensure_cmd docker    "brew install --cask docker"
ensure_cmd kubectl   "brew install kubernetes-cli"
ensure_cmd envsubst  "brew install gettext && brew link --force gettext"
ensure_cmd openssl   "(ships with macOS — check your \$PATH)"
ensure_cmd minikube  "brew install minikube"
ensure_docker_running
ensure_minikube_up
echo "  ok"
echo ""

echo "Secrets:"
ensure_secret telegram-bot-token token TELEGRAM_BOT_TOKEN \
  "Telegram bot token (from @BotFather)"
ensure_secret anthropic-api       key   ANTHROPIC_API_KEY \
  "Anthropic API key (sk-ant-...)"
echo ""

echo "Allowlist:"
prompt_allowlist TELEGRAM_ALLOWLIST \
  "Telegram usernames allowed to use this agent (comma-separated, e.g. alice,bob)"
echo "  rendered: $TELEGRAM_ALLOWLIST_JSON"
echo ""

export TELEGRAM_ALLOWLIST_JSON

echo "Staging manifests → $PRESET_STAGE_DIR"
stage_manifests "$PRESET_REPO/workloads" "$PRESET_STAGE_DIR" \
  claude-code.yaml claude-code-pool.yaml claude-code-trigger.yaml
echo "  ok"
echo ""

echo "Applying manifests..."
apply_manifests "$PRESET_STAGE_DIR"
echo ""

echo "Starting dev server..."
exec_dev
```

- [ ] **Step 2: Make it executable.**

```bash
chmod +x /Users/z/work/boilerhouse/.kadai/actions/presets/claude-code.sh
```

- [ ] **Step 3: Verify syntax and shellcheck.**

```bash
cd /Users/z/work/boilerhouse
bash -n .kadai/actions/presets/claude-code.sh && echo syntax-OK
command -v shellcheck >/dev/null && shellcheck -x .kadai/actions/presets/claude-code.sh || true
```

Expected: `syntax-OK`.

- [ ] **Step 4: Verify kadai discovers the action.**

```bash
cd /Users/z/work/boilerhouse
bunx kadai list --json | python3 -c "
import sys, json
actions = json.load(sys.stdin)
ids = [a['id'] for a in actions]
assert 'presets/claude-code' in ids, f'claude-code preset missing; got {ids}'
print('discovered:', [a for a in actions if a['id']=='presets/claude-code'][0]['name'])
"
```

Expected: `discovered: Claude Code preset`.

- [ ] **Step 5: Commit.**

```bash
git add .kadai/actions/presets/claude-code.sh
git commit -m "feat(kadai): claude-code preset action"
```

---

## Task 5: Openclaw preset script

**Files:**
- Create: `.kadai/actions/presets/openclaw.sh`

- [ ] **Step 1: Write the script.**

Create `.kadai/actions/presets/openclaw.sh`:

```bash
#!/bin/bash
# kadai:name OpenClaw preset
# kadai:emoji 🦀
# kadai:description One-command Telegram-driven OpenClaw agent with allowlist auth.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./_lib.sh
source "$HERE/_lib.sh"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║     Boilerhouse: OpenClaw preset          ║"
echo "╚══════════════════════════════════════════╝"
echo ""

echo "Prerequisites:"
ensure_cmd docker    "brew install --cask docker"
ensure_cmd kubectl   "brew install kubernetes-cli"
ensure_cmd envsubst  "brew install gettext && brew link --force gettext"
ensure_cmd openssl   "(ships with macOS — check your \$PATH)"
ensure_cmd minikube  "brew install minikube"
ensure_docker_running
ensure_minikube_up
echo "  ok"
echo ""

echo "Secrets:"
ensure_secret telegram-bot-token token TELEGRAM_BOT_TOKEN \
  "Telegram bot token (from @BotFather)"
ensure_secret anthropic-api       key   ANTHROPIC_API_KEY \
  "Anthropic API key (sk-ant-...)"
ensure_secret_generated openclaw-gateway-token token OPENCLAW_GATEWAY_TOKEN
echo ""

echo "Allowlist:"
prompt_allowlist TELEGRAM_ALLOWLIST \
  "Telegram usernames allowed to use this agent (comma-separated, e.g. alice,bob)"
echo "  rendered: $TELEGRAM_ALLOWLIST_JSON"
echo ""

export TELEGRAM_ALLOWLIST_JSON OPENCLAW_GATEWAY_TOKEN

echo "Staging manifests → $PRESET_STAGE_DIR"
stage_manifests "$PRESET_REPO/workloads" "$PRESET_STAGE_DIR" \
  openclaw.yaml openclaw-pool.yaml openclaw-trigger.yaml
echo "  ok"
echo ""

echo "Applying manifests..."
apply_manifests "$PRESET_STAGE_DIR"
echo ""

echo "Starting dev server..."
exec_dev
```

- [ ] **Step 2: Make it executable.**

```bash
chmod +x /Users/z/work/boilerhouse/.kadai/actions/presets/openclaw.sh
```

- [ ] **Step 3: Verify syntax and kadai discovery.**

```bash
cd /Users/z/work/boilerhouse
bash -n .kadai/actions/presets/openclaw.sh && echo syntax-OK
bunx kadai list --json | python3 -c "
import sys, json
actions = json.load(sys.stdin)
ids = [a['id'] for a in actions]
assert 'presets/openclaw' in ids, f'openclaw preset missing; got {ids}'
print('discovered:', [a for a in actions if a['id']=='presets/openclaw'][0]['name'])
"
```

Expected: `syntax-OK` and `discovered: OpenClaw preset`.

- [ ] **Step 4: Commit.**

```bash
git add .kadai/actions/presets/openclaw.sh
git commit -m "feat(kadai): openclaw preset action"
```

---

## Task 6: Template-render dry-run verification (optional but recommended)

A last pre-flight that exercises the full envsubst + kubectl-dry-run path without touching a real cluster.

**Files:** none (read-only checks).

- [ ] **Step 1: Dry-run both triggers.**

```bash
cd /Users/z/work/boilerhouse
TELEGRAM_ALLOWLIST_JSON='["tg-test"]' envsubst < workloads/claude-code-trigger.yaml \
  | kubectl apply --dry-run=client --validate=false -f -

TELEGRAM_ALLOWLIST_JSON='["tg-test"]' envsubst < workloads/openclaw-trigger.yaml \
  | kubectl apply --dry-run=client --validate=false -f -
```

Expected: each prints `boilerhousetrigger.boilerhouse.dev/... created (dry run)` (or similar). Ignore any warnings about the server not being reachable — `--validate=false` keeps this purely client-side.

- [ ] **Step 2: Dry-run the openclaw workload.**

```bash
OPENCLAW_GATEWAY_TOKEN=deadbeef envsubst < workloads/openclaw.yaml \
  | kubectl apply --dry-run=client --validate=false -f -
```

Expected: prints `boilerhouseworkload.boilerhouse.dev/openclaw created (dry run)`.

- [ ] **Step 3: Confirm no leftover placeholders.**

```bash
cd /Users/z/work/boilerhouse
grep -rE '\$\{[A-Za-z_]' workloads/
```

Expected: only the intended placeholders — `${TELEGRAM_ALLOWLIST_JSON}` in two trigger files, `${OPENCLAW_GATEWAY_TOKEN}` in `openclaw.yaml`. Nothing else.

---

## Manual smoke test (run at least once before calling the branch done)

Not a plan step — documented checklist for the human running verification against a live minikube.

```
□ bunx kadai run nuke; minikube delete -p boilerhouse
□ bunx kadai run presets/claude-code
    □ enter a real Telegram bot token
    □ enter a real Anthropic key
    □ enter your own Telegram username (e.g. alice)
    □ dev.sh starts
    □ Telegram /start to the bot → agent replies
□ Ctrl+C dev.sh; run bunx kadai run presets/claude-code again
    □ "reusing existing Secret telegram-bot-token"
    □ "reusing existing Secret anthropic-api"
    □ prompt reappears for allowlist only
    □ dev.sh restarts
□ kubectl -n boilerhouse delete secret anthropic-api
□ Re-run presets/claude-code
    □ Secret re-prompted for the Anthropic key only
□ Repeat for presets/openclaw
    □ openclaw-gateway-token generated silently on first run
    □ reused on re-run (no value prompted)
```

---

## Self-Review Notes

After all tasks complete:

- **Schema coherence.** The two trigger YAMLs use `${TELEGRAM_ALLOWLIST_JSON}`. Both preset scripts call `prompt_allowlist TELEGRAM_ALLOWLIST ...` which sets `TELEGRAM_ALLOWLIST_JSON` and exports it. Check the name matches exactly (underscore, case).
- **Gateway token double-wiring.** Only the openclaw preset handles `OPENCLAW_GATEWAY_TOKEN`. It's used in both `workloads/openclaw.yaml` (env var) and `workloads/openclaw-trigger.yaml`'s `gatewayTokenSecretRef` (which points at the K8s Secret, not the env var). Verify the Secret value exported into `OPENCLAW_GATEWAY_TOKEN` and the Secret's `token` key hold the same literal.
- **Idempotency.** `ensure_secret` and `ensure_secret_generated` both return early with `reusing existing Secret` if the named Secret exists. Re-run produces no prompts for existing Secrets.
- **No unresolved placeholders at apply time.** `stage_manifests` greps for `${...}` after envsubst and aborts if any remain. Confirm the regex `\$\{[A-Za-z_][A-Za-z_0-9]*\}` catches the placeholder style used in the templates.
- **`exec_dev` is the last line of each preset.** `exec` replaces the shell — anything after it in the script is unreachable. Double-check both preset scripts end cleanly on `exec_dev`.
