#!/bin/bash
# kadai:name Pi preset
# kadai:emoji 🤖
# kadai:description One-command Telegram-driven Pi agent with allowlist auth.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./_lib.sh
source "$HERE/_lib.sh"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║       Boilerhouse: Pi preset              ║"
echo "╚══════════════════════════════════════════╝"
echo ""

echo "Prerequisites:"
ensure_cmd docker \
  "brew install --cask docker" \
  "see https://docs.docker.com/engine/install/ for your distro"
ensure_cmd kubectl \
  "brew install kubernetes-cli" \
  "see https://kubernetes.io/docs/tasks/tools/install-kubectl-linux/"
ensure_cmd envsubst \
  "brew install gettext && brew link --force gettext" \
  "sudo apt install gettext-base  # (or your distro's gettext package)"
ensure_cmd openssl \
  "(ships with macOS — check your \$PATH)" \
  "sudo apt install openssl  # (or your distro's openssl package)"
ensure_cmd minikube \
  "brew install minikube" \
  "curl -LO https://storage.googleapis.com/minikube/releases/latest/minikube-linux-amd64 && sudo install minikube-linux-amd64 /usr/local/bin/minikube"
ensure_cmd curl \
  "(ships with macOS — check your \$PATH)" \
  "sudo apt install curl  # (or your distro's curl package)"
ensure_cmd bun \
  "brew install oven-sh/bun/bun" \
  "curl -fsSL https://bun.sh/install | bash"
ensure_go_version
ensure_docker_running
ensure_minikube_up
ensure_minikube_resources
echo "  ok"
echo ""

echo "Installing project dependencies..."
run_setup
echo ""

echo "Secrets:"
ensure_secret telegram-bot-token token TELEGRAM_BOT_TOKEN \
  "Telegram bot token (from @BotFather)"
ensure_secret anthropic-api       key   ANTHROPIC_API_KEY \
  "Anthropic API key (sk-ant-...)"
echo ""

echo "Allowlist:"
ensure_allowlist pi TELEGRAM_ALLOWLIST \
  "Telegram usernames allowed to use this agent (comma-separated, e.g. alice,bob)"
echo "  rendered: $TELEGRAM_ALLOWLIST_JSON"
echo ""

export TELEGRAM_ALLOWLIST_JSON

echo "Staging manifests → $PRESET_STAGE_DIR"
stage_manifests "$PRESET_REPO/workloads" "$PRESET_STAGE_DIR" \
  pi.yaml pi-pool.yaml pi-trigger.yaml
echo "  ok"
echo ""

echo "Applying manifests..."
apply_manifests "$PRESET_STAGE_DIR"
echo ""

print_bot_banner "$TELEGRAM_BOT_TOKEN" "$TELEGRAM_ALLOWLIST_JSON"

echo "Starting dev server..."
exec_dev
