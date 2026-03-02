#!/bin/bash
# kadai:name Start/Restart Daemon
# kadai:emoji 🔄
# kadai:description Start or restart the boilerhoused runtime daemon (manages podman internally)

set -euo pipefail

RUNTIME_SOCKET="${LISTEN_SOCKET:-/run/boilerhouse/runtime.sock}"
PODMAN_SOCKET="${PODMAN_SOCKET:-/run/boilerhouse/podman.sock}"
SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
DAEMON_SCRIPT="$SCRIPT_DIR/scripts/start-boilerhoused.sh"

# Kill any existing processes on our sockets.
# boilerhoused manages podman as a child, but if it died uncleanly
# the podman process may still be lingering on its socket.
for sock in "$RUNTIME_SOCKET" "$PODMAN_SOCKET"; do
  if [ -S "$sock" ]; then
    EXISTING_PID=$(sudo lsof -t "$sock" 2>/dev/null || true)
    if [ -n "$EXISTING_PID" ]; then
      echo "Stopping process on $sock (PID $EXISTING_PID)..."
      sudo kill "$EXISTING_PID" 2>/dev/null || true
    fi
    # Give it a moment to clean up, then force-remove stale socket
    sleep 0.3
    if [ -S "$sock" ]; then
      sudo rm -f "$sock"
    fi
  fi
done

echo "Starting boilerhoused..."
sudo "$DAEMON_SCRIPT" --background

# Verify the runtime socket is up
if [ -S "$RUNTIME_SOCKET" ]; then
  PID=$(sudo lsof -t "$RUNTIME_SOCKET" 2>/dev/null || true)
  echo ""
  echo "boilerhoused is running (PID $PID)."
  echo "  runtime socket: $RUNTIME_SOCKET"
  echo "  podman socket:  $PODMAN_SOCKET (managed)"
  echo ""
  echo "To stop: sudo kill $PID"
else
  echo "Error: daemon failed to start." >&2
  exit 1
fi
