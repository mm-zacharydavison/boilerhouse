#!/usr/bin/env bash
# Builds a Firecracker rootfs from python:3-alpine with the boilerhouse
# init binary injected. The resulting image runs python3 -m http.server
# when launched with the appropriate entrypoint boot args.
#
# Usage: ./scripts/build-httpserver-image.sh [--output-dir <dir>] [--init-binary <path>] [--dry-run]
#
# Defaults:
#   --output-dir   /var/lib/boilerhouse/images/firecracker-httpserver/latest
#   --init-binary  packages/guest-init/build/x86_64/init

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

OUTPUT_DIR="/var/lib/boilerhouse/images/firecracker-httpserver/latest"
INIT_BINARY="$PROJECT_ROOT/packages/guest-init/build/x86_64/init"
DRY_RUN=false
SIZE_MB=512

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir)
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --init-binary)
      INIT_BINARY="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--output-dir <dir>] [--init-binary <path>] [--dry-run]"
      exit 1
      ;;
  esac
done

OUTPUT_PATH="$OUTPUT_DIR/rootfs.ext4"

echo "=== Building httpserver rootfs ==="
echo "Docker image:  python:3-alpine"
echo "Init binary:   $INIT_BINARY"
echo "Output:        $OUTPUT_PATH"
echo "Size:          ${SIZE_MB} MiB"
echo ""

if $DRY_RUN; then
  echo "[dry-run] Would run:"
  echo "  $SCRIPT_DIR/docker-to-rootfs.sh python:3-alpine $OUTPUT_PATH $SIZE_MB --inject-init $INIT_BINARY --dry-run"
  echo ""
  exec "$SCRIPT_DIR/docker-to-rootfs.sh" python:3-alpine "$OUTPUT_PATH" "$SIZE_MB" \
    --inject-init "$INIT_BINARY" --dry-run
fi

if [[ ! -f "$INIT_BINARY" ]]; then
  echo "Error: init binary not found at '$INIT_BINARY'"
  echo "Build it first: make -C $PROJECT_ROOT/packages/guest-init"
  exit 1
fi

exec "$SCRIPT_DIR/docker-to-rootfs.sh" python:3-alpine "$OUTPUT_PATH" "$SIZE_MB" \
  --inject-init "$INIT_BINARY"
