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
