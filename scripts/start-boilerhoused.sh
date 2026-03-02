#!/usr/bin/env bash
set -euo pipefail

# Starts boilerhoused for development.
# boilerhoused manages the podman daemon internally — no separate podman
# script is needed.
#
# Usage:
#   sudo scripts/start-boilerhoused.sh
#   sudo scripts/start-boilerhoused.sh --dry-run
#   sudo scripts/start-boilerhoused.sh --background

PODMAN_SOCKET="/run/boilerhouse/podman.sock"
LISTEN_SOCKET="/run/boilerhouse/runtime.sock"
SNAPSHOT_DIR="/var/lib/boilerhouse/snapshots"
DRY_RUN=false
BACKGROUND=false
CALLER_GROUP="${SUDO_GID:-$(id -g)}"

# Resolve bun path before sudo strips PATH
BUN="${BUN:-$(command -v bun 2>/dev/null || echo "")}"
if [ -z "$BUN" ]; then
	# Common install locations
	for candidate in /home/*/.bun/bin/bun /usr/local/bin/bun; do
		# shellcheck disable=SC2086
		for path in $candidate; do
			if [ -x "$path" ]; then
				BUN="$path"
				break 2
			fi
		done
	done
fi

for arg in "$@"; do
	case "$arg" in
		--dry-run)
			DRY_RUN=true
			;;
		--background)
			BACKGROUND=true
			;;
	esac
done

run() {
	if [ "$DRY_RUN" = true ]; then
		echo "[dry-run] $*"
	else
		"$@"
	fi
}

if [ -z "$BUN" ]; then
	echo "Error: bun not found. Install bun or set BUN=/path/to/bun." >&2
	exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
	echo "Error: This script must be run as root (use sudo)." >&2
	exit 1
fi

# Remove stale sockets
for sock in "$PODMAN_SOCKET" "$LISTEN_SOCKET"; do
	if [ -S "$sock" ]; then
		echo "Removing stale socket $sock..."
		run rm -f "$sock"
	fi
done

echo "Creating directories..."
run mkdir -p /run/boilerhouse "$SNAPSHOT_DIR"
run chmod 700 "$SNAPSHOT_DIR"

echo "Starting boilerhoused (manages podman internally)..."
if [ "$DRY_RUN" = true ]; then
	echo "[dry-run] umask 0117"
	echo "[dry-run] PODMAN_SOCKET=$PODMAN_SOCKET LISTEN_SOCKET=$LISTEN_SOCKET SNAPSHOT_DIR=$SNAPSHOT_DIR $BUN apps/boilerhoused/src/main.ts &"
	echo "[dry-run] chgrp $CALLER_GROUP $LISTEN_SOCKET"
	echo "[dry-run] chmod 660 $LISTEN_SOCKET"
else
	umask 0117

	export PODMAN_SOCKET
	export LISTEN_SOCKET
	export SNAPSHOT_DIR

	# Start boilerhoused — keep stderr visible so startup errors are shown
	if [ "$BACKGROUND" = true ]; then
		"$BUN" apps/boilerhoused/src/main.ts >/dev/null &
	else
		"$BUN" apps/boilerhoused/src/main.ts &
	fi
	DAEMON_PID=$!

	# Wait for runtime socket to appear (boilerhoused needs to start podman first)
	for _ in $(seq 1 100); do
		if [ -S "$LISTEN_SOCKET" ]; then
			break
		fi
		# Check if process already died
		if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
			echo "Error: boilerhoused exited before creating socket." >&2
			wait "$DAEMON_PID" 2>/dev/null || true
			exit 1
		fi
		sleep 0.1
	done

	if [ ! -S "$LISTEN_SOCKET" ]; then
		echo "Error: Daemon socket did not appear within 10 seconds." >&2
		kill "$DAEMON_PID" 2>/dev/null || true
		exit 1
	fi

	chgrp "$CALLER_GROUP" "$LISTEN_SOCKET"
	chmod 660 "$LISTEN_SOCKET"

	echo "boilerhoused listening on $LISTEN_SOCKET (PID $DAEMON_PID)"
	echo "  podman socket: $PODMAN_SOCKET (managed, 0600)"
	echo "  runtime socket: $LISTEN_SOCKET (GID $CALLER_GROUP, 0660)"
	echo "  snapshot dir:  $SNAPSHOT_DIR"
	echo ""
	echo "To stop: sudo kill $DAEMON_PID"

	if [ "$BACKGROUND" = true ]; then
		disown "$DAEMON_PID"
	else
		wait "$DAEMON_PID"
	fi
fi
