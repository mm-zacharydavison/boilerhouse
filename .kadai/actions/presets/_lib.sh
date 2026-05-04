#!/usr/bin/env bash
# Shared helpers for boilerhouse preset actions.
# Source this file — do not execute directly.

# Callers must have already set: set -euo pipefail

PRESET_NS="boilerhouse"
PRESET_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PRESET_STAGE_DIR="$PRESET_REPO/.boilerhouse-preset/workloads"

case "$(uname -s)" in
  Darwin) PRESET_OS="mac" ;;
  Linux)  PRESET_OS="linux" ;;
  *)      PRESET_OS="unknown" ;;
esac

# ── Prereq checks ────────────────────────────────────────────────────────────

# ensure_cmd NAME MAC_HINT LINUX_HINT
# Errors with the OS-appropriate install hint if NAME isn't on $PATH.
ensure_cmd() {
  local name="$1" mac_hint="$2" linux_hint="$3"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "Error: $name not installed."
    case "$PRESET_OS" in
      mac)   echo "  Install with: $mac_hint" ;;
      linux) echo "  Install with: $linux_hint" ;;
      *)     echo "  Install (macOS):  $mac_hint"
             echo "  Install (Linux):  $linux_hint" ;;
    esac
    exit 1
  fi
}

# Go 1.26+ is required (see go/go.mod).
ensure_go_version() {
  ensure_cmd go \
    "brew install go" \
    "download from https://go.dev/dl/ (distro packages are often too old)"
  local ver major minor
  ver="$(go env GOVERSION 2>/dev/null | sed 's/^go//')"
  major="${ver%%.*}"
  minor="${ver#*.}"; minor="${minor%%.*}"
  if [ -z "$major" ] || [ -z "$minor" ]; then
    echo "Error: could not parse Go version from 'go env GOVERSION' (got: $ver)"
    exit 1
  fi
  if [ "$major" -lt 1 ] || { [ "$major" -eq 1 ] && [ "$minor" -lt 26 ]; }; then
    echo "Error: Go 1.26+ required (found $ver)."
    case "$PRESET_OS" in
      mac)   echo "  Upgrade with: brew upgrade go" ;;
      linux) echo "  Upgrade: download from https://go.dev/dl/" ;;
      *)     echo "  Upgrade: see https://go.dev/dl/" ;;
    esac
    exit 1
  fi
}

# Warn (don't fail) if the existing minikube profile has fewer resources than
# the recommended minimum. minikube.sh starts fresh profiles with 4 CPU / 4Gi,
# but a pre-existing profile may have been started with less.
ensure_minikube_resources() {
  local profile="boilerhouse"
  local cpus mem_mb
  cpus="$(minikube -p "$profile" config view 2>/dev/null | awk -F': ' '/^- cpus:/ {print $2}' | tr -d ' ')"
  mem_mb="$(minikube -p "$profile" config view 2>/dev/null | awk -F': ' '/^- memory:/ {print $2}' | tr -d ' ')"
  if [ -n "$cpus" ] && [ "$cpus" -lt 4 ]; then
    echo "  warning: minikube profile '$profile' has $cpus CPU (recommended: 4+)"
  fi
  if [ -n "$mem_mb" ] && [ "$mem_mb" -lt 4096 ]; then
    echo "  warning: minikube profile '$profile' has ${mem_mb}Mi memory (recommended: 4096+)"
  fi
}

# Run the monorepo setup script (Go deps, envtest, controller-gen, bun install).
# Idempotent; skips work that's already done.
run_setup() {
  bash "$PRESET_REPO/.kadai/actions/setup.sh"
}

ensure_docker_running() {
  if ! docker info >/dev/null 2>&1; then
    echo "Error: Docker daemon is not running."
    case "$PRESET_OS" in
      mac)   echo "  Start Docker Desktop (or OrbStack) and retry." ;;
      linux) echo "  Start it with: sudo systemctl start docker" ;;
      *)     echo "  Start your Docker daemon and retry." ;;
    esac
    exit 1
  fi
}

ensure_minikube_up() {
  local profile="boilerhouse"
  if minikube status -p "$profile" >/dev/null 2>&1; then
    return 0
  fi
  echo "minikube profile '$profile' not running — bootstrapping..."
  bash "$PRESET_REPO/.kadai/actions/minikube.sh"
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

# ensure_allowlist PRESET_ID VAR PROMPT
# Reads the allowlist JSON from a per-preset ConfigMap if one exists;
# otherwise prompts (via prompt_allowlist) and saves the JSON to a fresh
# ConfigMap so the next run reuses it. User can rotate with:
#   kubectl -n boilerhouse delete configmap boilerhouse-preset-<preset-id>
ensure_allowlist() {
  local preset_id="$1" var="$2" prompt="$3"
  local cm="boilerhouse-preset-$preset_id"

  if kubectl -n "$PRESET_NS" get configmap "$cm" >/dev/null 2>&1; then
    local existing
    existing="$(kubectl -n "$PRESET_NS" get configmap "$cm" -o jsonpath='{.data.allowlist}')"
    if [ -n "$existing" ]; then
      printf -v "${var}_JSON" '%s' "$existing"
      echo "  reusing allowlist from ConfigMap $cm: $existing"
      return 0
    fi
  fi

  prompt_allowlist "$var" "$prompt"
  local json_var="${var}_JSON"
  kubectl -n "$PRESET_NS" create configmap "$cm" \
    --from-literal="allowlist=${!json_var}" >/dev/null
  echo "  saved allowlist to ConfigMap $cm"
}

# ── Template rendering and apply ────────────────────────────────────────────

# stage_manifests SRC_DIR DST_DIR FILE...
# envsubsts each FILE from SRC_DIR into DST_DIR. Before substitution, scans
# each template for ${VAR} references and aborts if any referenced variable
# is unset or empty — so a typo or forgotten export fails loudly rather than
# silently producing an empty string.
stage_manifests() {
  local src="$1" dst="$2"
  shift 2
  # Always start from a clean dst. Prevents stale files from a previous run
  # (including broken symlinks from the old TS preset layout) leaking into
  # the kubectl apply.
  mkdir -p "$dst"
  find "$dst" -mindepth 1 -delete
  local f
  for f in "$@"; do
    # Scan the template for ${VAR} references. Uniquify.
    local refs
    refs="$(grep -oE '\$\{[A-Za-z_][A-Za-z_0-9]*\}' "$src/$f" | sort -u || true)"

    # Verify each referenced variable is set + non-empty in the environment.
    local ref name
    for ref in $refs; do
      name="${ref#\$\{}"
      name="${name%\}}"
      if [ -z "${!name:-}" ]; then
        echo "Error: template $src/$f references unset variable $ref"
        exit 1
      fi
    done

    envsubst <"$src/$f" >"$dst/$f"
  done
}

apply_manifests() {
  local dir="$1"
  kubectl -n "$PRESET_NS" apply -f "$dir"
}

exec_dev() {
  # Point dev.sh at the preset's staging dir so it only applies the
  # preset-selected workloads (not every YAML under workloads/).
  export WORKLOADS_APPLY_DIR="$PRESET_STAGE_DIR"
  exec bash "$PRESET_REPO/.kadai/actions/dev.sh"
}

# print_bot_banner TOKEN ALLOWLIST_JSON
# Resolves the Telegram bot's @username from the token and prints a banner
# telling the user who to DM. Falls back to a generic message on failure.
print_bot_banner() {
  local token="$1" allowlist_json="$2"
  local username=""
  if command -v curl >/dev/null 2>&1; then
    username="$(curl -sS --max-time 5 "https://api.telegram.org/bot${token}/getMe" 2>/dev/null \
      | grep -o '"username":"[^"]*"' | head -1 | cut -d'"' -f4)" || true
  fi
  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║                       Ready to chat                          ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  if [ -n "$username" ]; then
    echo "  → Open Telegram and message @${username}"
  else
    echo "  → Open Telegram and message your bot"
  fi
  echo "  → Allowlisted users: ${allowlist_json}"
  echo "  → Dashboard:         http://localhost:3001"
  echo "  → API:               http://localhost:3000"
  echo ""
}
