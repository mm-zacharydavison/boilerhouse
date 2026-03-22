#!/bin/bash
# kadai:name Nuke Local Data
# kadai:emoji 💣
# kadai:description Delete local database, data, and boilerhouse podman images
# kadai:confirm true

set -euo pipefail

# Resolve paths relative to project root
SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
API_DIR="$SCRIPT_DIR/apps/api"

DB_PATH="${DB_PATH:-$API_DIR/boilerhouse.db}"
STORAGE_PATH="${STORAGE_PATH:-$API_DIR/data}"

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "[dry-run] Would delete the following:"
fi

nuke() {
  local target="$1"
  if [[ -e "$target" ]]; then
    if $DRY_RUN; then
      echo "  $target"
    else
      rm -rf "$target"
      echo "Deleted $target"
    fi
  fi
}

# SQLite database + WAL/SHM journal files
nuke "$DB_PATH"
nuke "$DB_PATH-wal"
nuke "$DB_PATH-shm"

# Data directory (snapshots + tenant overlays)
nuke "$STORAGE_PATH"

# Daemon data directories (snapshots + proxy configs)
if [[ "$(uname -s)" == "Darwin" ]]; then
  nuke "$HOME/.local/share/boilerhouse/snapshots"
  nuke "$HOME/.local/share/boilerhouse/proxy-configs"
else
  nuke "/var/lib/boilerhouse/snapshots"
fi

# Kill the boilerhouse-podmand daemon if running
if [[ "$(uname -s)" == "Darwin" ]]; then
  RUNTIME_SOCKET="${RUNTIME_SOCKET:-$HOME/.local/share/boilerhouse/runtime.sock}"
else
  RUNTIME_SOCKET="${RUNTIME_SOCKET:-/var/run/boilerhouse/runtime.sock}"
fi

if [[ -S "$RUNTIME_SOCKET" ]]; then
  DAEMON_PID=$(lsof -t "$RUNTIME_SOCKET" 2>/dev/null || true)
  if [[ -n "$DAEMON_PID" ]]; then
    echo ""
    if $DRY_RUN; then
      echo "  Would kill boilerhouse-podmand (PID $DAEMON_PID)"
    else
      echo "Stopping boilerhouse-podmand (PID $DAEMON_PID)..."
      kill "$DAEMON_PID" 2>/dev/null || true
      sleep 0.5
    fi
  fi
  if ! $DRY_RUN; then
    rm -f "$RUNTIME_SOCKET"
  fi
fi

# Remove all podman pods and containers, but keep the machine and cached images
if command -v podman &>/dev/null && [[ "$(uname -s)" == "Darwin" ]]; then
  echo ""
  echo "Removing podman pods and containers..."
  if $DRY_RUN; then
    POD_COUNT=$(podman pod ls -q 2>/dev/null | wc -l | tr -d ' ')
    CONTAINER_COUNT=$(podman ps -aq 2>/dev/null | wc -l | tr -d ' ')
    echo "  Would remove $POD_COUNT pod(s) and $CONTAINER_COUNT container(s)"
  else
    podman pod rm --all --force 2>/dev/null || true
    podman rm --all --force 2>/dev/null || true
    echo "All pods and containers removed (images preserved)."
  fi
elif command -v podman &>/dev/null; then
  # Linux: no VM layer, just remove pods directly
  echo ""
  echo "Removing podman pods..."
  if $DRY_RUN; then
    POD_COUNT=$(podman pod ls -q 2>/dev/null | wc -l | tr -d ' ')
    echo "  Would remove $POD_COUNT pod(s)"
  else
    podman pod rm --all --force 2>/dev/null || true
    podman system prune --all --force 2>/dev/null || true
    echo "All pods and images removed."
  fi
fi

if ! $DRY_RUN; then
  echo ""
  echo "Done. All local data has been nuked."
fi
