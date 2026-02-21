#!/usr/bin/env bash
# Converts a Docker image to a Firecracker-compatible ext4 rootfs.
#
# Usage: ./scripts/docker-to-rootfs.sh <docker-image> <output-path> [size-mb]
#   docker-image  Docker image tag (e.g. openclaw:optimized)
#   output-path   Where to write the rootfs.ext4 file
#   size-mb       Size of the ext4 image in MiB (default: 8192)
#
# Requires: docker, mkfs.ext4 (with -d support, e2fsprogs >= 1.44)
# No sudo required — uses mkfs.ext4 -d to populate from a tarball.

set -euo pipefail

DRY_RUN=false
for arg in "$@"; do
  if [[ "$arg" == "--dry-run" ]]; then
    DRY_RUN=true
  fi
done

# Strip --dry-run from positional args
ARGS=()
for arg in "$@"; do
  if [[ "$arg" != "--dry-run" ]]; then
    ARGS+=("$arg")
  fi
done

DOCKER_IMAGE="${ARGS[0]:-}"
OUTPUT_PATH="${ARGS[1]:-}"
SIZE_MB="${ARGS[2]:-8192}"

if [[ -z "$DOCKER_IMAGE" || -z "$OUTPUT_PATH" ]]; then
  echo "Usage: $0 <docker-image> <output-path> [size-mb] [--dry-run]"
  echo ""
  echo "  docker-image  Docker image tag (e.g. openclaw:optimized)"
  echo "  output-path   Where to write the rootfs.ext4 file"
  echo "  size-mb       Size of the ext4 image in MiB (default: 8192)"
  exit 1
fi

CONTAINER_ID=""
TAR_FILE=""

cleanup() {
  if [[ -n "$CONTAINER_ID" ]]; then
    docker rm "$CONTAINER_ID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$TAR_FILE" && -f "$TAR_FILE" ]]; then
    rm -f "$TAR_FILE"
  fi
}
trap cleanup EXIT

echo "Docker image:  $DOCKER_IMAGE"
echo "Output path:   $OUTPUT_PATH"
echo "Image size:    ${SIZE_MB} MiB"
echo ""

if $DRY_RUN; then
  echo "[dry-run] Would:"
  echo "  1. Create container from $DOCKER_IMAGE"
  echo "  2. Export filesystem to tarball"
  echo "  3. Create ${SIZE_MB}M ext4 image at $OUTPUT_PATH (via mkfs.ext4 -d)"
  echo "  4. Shrink to actual size"
  exit 0
fi

# Ensure output directory exists
mkdir -p "$(dirname "$OUTPUT_PATH")"

# Step 1: Create a throwaway container (not started)
echo "Creating container from $DOCKER_IMAGE..."
CONTAINER_ID=$(docker create "$DOCKER_IMAGE" /bin/true)
echo "  container: ${CONTAINER_ID:0:12}"

# Step 2: Export container filesystem to a tarball
TAR_FILE=$(mktemp --suffix=.tar)
echo "Exporting filesystem to tarball..."
docker export "$CONTAINER_ID" > "$TAR_FILE"
TAR_SIZE=$(stat --format=%s "$TAR_FILE")
TAR_MB=$((TAR_SIZE / 1048576))
echo "  tarball: ${TAR_MB} MiB"

# Step 3: Create ext4 image populated from the tarball (no mount needed)
echo "Creating ext4 image from tarball (this may take a moment)..."
mkfs.ext4 -F -L rootfs -d "$TAR_FILE" "$OUTPUT_PATH" "${SIZE_MB}M"

# Step 4: Shrink to actual used size
echo "Shrinking filesystem..."
e2fsck -fy "$OUTPUT_PATH" >/dev/null 2>&1 || true
resize2fs -M "$OUTPUT_PATH" 2>/dev/null

FINAL_SIZE=$(stat --format=%s "$OUTPUT_PATH" 2>/dev/null || stat -f%z "$OUTPUT_PATH")
FINAL_MB=$((FINAL_SIZE / 1048576))
echo ""
echo "Done! rootfs at $OUTPUT_PATH (${FINAL_MB} MiB)"
