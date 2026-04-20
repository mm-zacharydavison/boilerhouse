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
