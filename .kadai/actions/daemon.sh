#!/bin/bash
# kadai:name Start/Restart Daemon
# kadai:emoji 🔄
# kadai:description Start or restart the boilerhoused runtime daemon (manages podman internally)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
DAEMON_SCRIPT="$SCRIPT_DIR/scripts/start-boilerhoused.sh"

IS_MACOS=false
if [ "$(uname -s)" = "Darwin" ]; then
  IS_MACOS=true
fi

# Platform-appropriate defaults
if [ "$IS_MACOS" = true ]; then
  RUNTIME_SOCKET="${LISTEN_SOCKET:-$HOME/.local/share/boilerhouse/runtime.sock}"
  # macOS: podman socket comes from the machine, no fixed path
  SOCKETS_TO_CHECK=("$RUNTIME_SOCKET")
else
  RUNTIME_SOCKET="${LISTEN_SOCKET:-/var/run/boilerhouse/runtime.sock}"
  PODMAN_SOCKET="${PODMAN_SOCKET:-/var/run/boilerhouse/podman.sock}"
  SOCKETS_TO_CHECK=("$RUNTIME_SOCKET" "$PODMAN_SOCKET")
fi

# Install podman if not present
if ! command -v podman &>/dev/null; then
  echo "podman not found — installing..."
  case "$(uname -s)" in
    Darwin)
      if command -v brew &>/dev/null; then
        brew install podman
      else
        echo "Error: Homebrew not found. Install podman manually: https://podman.io/docs/installation" >&2
        exit 1
      fi
      ;;
    Linux)
      if command -v apt-get &>/dev/null; then
        sudo apt-get update -qq && sudo apt-get install -y -qq podman
      elif command -v dnf &>/dev/null; then
        sudo dnf install -y podman
      elif command -v pacman &>/dev/null; then
        sudo pacman -S --noconfirm podman
      else
        echo "Error: Could not detect package manager. Install podman manually." >&2
        exit 1
      fi
      ;;
    *)
      echo "Error: Unsupported OS. Install podman manually: https://podman.io/docs/installation" >&2
      exit 1
      ;;
  esac
fi

# Helper: run a command with sudo on Linux, directly on macOS
run_privileged() {
  if [ "$IS_MACOS" = true ]; then
    "$@"
  else
    sudo "$@"
  fi
}

# Kill any existing processes on our sockets.
# boilerhoused manages podman as a child, but if it died uncleanly
# the podman process may still be lingering on its socket.
for sock in "${SOCKETS_TO_CHECK[@]}"; do
  if [ -S "$sock" ]; then
    EXISTING_PID=$(run_privileged lsof -t "$sock" 2>/dev/null || true)
    if [ -n "$EXISTING_PID" ]; then
      echo "Stopping process on $sock (PID $EXISTING_PID)..."
      run_privileged kill "$EXISTING_PID" 2>/dev/null || true
    fi
    # Give it a moment to clean up, then force-remove stale socket
    sleep 0.3
    if [ -S "$sock" ]; then
      run_privileged rm -f "$sock"
    fi
  fi
done

echo "Starting boilerhoused..."
if [ "$IS_MACOS" = true ]; then
  "$DAEMON_SCRIPT" --background
else
  sudo BUN="$(command -v bun)" "$DAEMON_SCRIPT" --background
fi

# Verify the runtime socket is up
if [ ! -S "$RUNTIME_SOCKET" ]; then
  echo "Error: daemon failed to start." >&2
  exit 1
fi
