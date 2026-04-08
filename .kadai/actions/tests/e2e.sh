#!/bin/bash
# kadai:name E2E Tests
# kadai:emoji 🧪
# kadai:description Run E2E tests against a selected runtime (ensures infrastructure is ready)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"

# ── Runtime selection ────────────────────────────────────────────────────────

echo "Select runtime for E2E tests:"
echo "  1) fake        — In-memory fake runtime (no infra needed)"
echo "  2) docker      — Container runtime via Docker daemon"
echo "  3) all         — All available runtimes"
echo ""
read -rp "Runtime [1]: " RUNTIME_CHOICE

case "${RUNTIME_CHOICE:-1}" in
  1|fake)   RUNTIMES="fake" ;;
  2|docker) RUNTIMES="docker" ;;
  3|all)    RUNTIMES="all" ;;
  *)
    echo "Invalid choice: $RUNTIME_CHOICE" >&2
    exit 1
    ;;
esac

echo ""

# ── Ensure runtime infrastructure ───────────────────────────────────────────

ensure_docker() {
  if ! docker info &>/dev/null; then
    echo "Error: Docker daemon is not running or not accessible." >&2
    echo "Hint: Start Docker Desktop or run: sudo systemctl start docker" >&2
    exit 1
  fi
  echo "✓ Docker daemon is running"
}

if [ "$RUNTIMES" = "docker" ] || [ "$RUNTIMES" = "all" ]; then
  ensure_docker
fi

echo ""

# ── Run E2E tests ────────────────────────────────────────────────────────────

if [ "$RUNTIMES" = "all" ]; then
  echo "Running E2E tests against all available runtimes..."
  exec bun test tests/e2e/ --timeout 120000
else
  echo "Running E2E tests against: $RUNTIMES"
  exec env BOILERHOUSE_E2E_RUNTIMES="$RUNTIMES" bun test tests/e2e/ --timeout 120000
fi
