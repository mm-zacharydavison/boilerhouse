#!/usr/bin/env bash
# Converts a Docker image to a Firecracker-compatible ext4 rootfs.
#
# Usage: ./scripts/docker-to-rootfs.sh <docker-image> <output-path> [size-mb] [--inject-init <path>] [--dry-run]
#   docker-image       Docker image tag (e.g. openclaw:optimized)
#   output-path        Where to write the rootfs.ext4 file
#   size-mb            Size of the ext4 image in MiB (default: 8192)
#   --inject-init <p>  Copy a static init binary into /opt/boilerhouse/init in the rootfs
#   --dry-run          Print what would happen without doing it
#
# Requires: docker, mkfs.ext4 (with -d support, e2fsprogs >= 1.44)
# No sudo required — uses mkfs.ext4 -d to populate from a directory.

set -euo pipefail

DRY_RUN=false
INJECT_INIT=""

# Parse named flags first
POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --inject-init)
      INJECT_INIT="$2"
      shift 2
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

DOCKER_IMAGE="${POSITIONAL[0]:-}"
OUTPUT_PATH="${POSITIONAL[1]:-}"
SIZE_MB="${POSITIONAL[2]:-8192}"

if [[ -z "$DOCKER_IMAGE" || -z "$OUTPUT_PATH" ]]; then
  echo "Usage: $0 <docker-image> <output-path> [size-mb] [--inject-init <path>] [--dry-run]"
  echo ""
  echo "  docker-image       Docker image tag (e.g. openclaw:optimized)"
  echo "  output-path        Where to write the rootfs.ext4 file"
  echo "  size-mb            Size of the ext4 image in MiB (default: 8192)"
  echo "  --inject-init <p>  Copy a static init binary into /opt/boilerhouse/init"
  echo "  --dry-run          Print what would happen without doing it"
  exit 1
fi

if [[ -n "$INJECT_INIT" && ! -f "$INJECT_INIT" ]]; then
  echo "Error: init binary not found at '$INJECT_INIT'"
  echo "Build it first: make -C packages/guest-init"
  exit 1
fi

CONTAINER_ID=""
ROOTFS_DIR=""

cleanup() {
  if [[ -n "$CONTAINER_ID" ]]; then
    docker rm "$CONTAINER_ID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$ROOTFS_DIR" && -d "$ROOTFS_DIR" ]]; then
    rm -rf "$ROOTFS_DIR"
  fi
}
trap cleanup EXIT

echo "Docker image:  $DOCKER_IMAGE"
echo "Output path:   $OUTPUT_PATH"
echo "Image size:    ${SIZE_MB} MiB"
if [[ -n "$INJECT_INIT" ]]; then
  echo "Inject init:   $INJECT_INIT"
fi
echo ""

if $DRY_RUN; then
  echo "[dry-run] Would:"
  echo "  1. Create container from $DOCKER_IMAGE"
  echo "  2. Export filesystem to directory"
  if [[ -n "$INJECT_INIT" ]]; then
    echo "  3. Inject init binary from $INJECT_INIT at /opt/boilerhouse/init"
    echo "  4. Create ${SIZE_MB}M ext4 image at $OUTPUT_PATH (via mkfs.ext4 -d)"
    echo "  5. Shrink to actual size"
  else
    echo "  3. Create ${SIZE_MB}M ext4 image at $OUTPUT_PATH (via mkfs.ext4 -d)"
    echo "  4. Shrink to actual size"
  fi
  exit 0
fi

# Ensure output directory exists
mkdir -p "$(dirname "$OUTPUT_PATH")"

# Step 1: Create a throwaway container (not started)
echo "Creating container from $DOCKER_IMAGE..."
CONTAINER_ID=$(docker create "$DOCKER_IMAGE" /bin/true)
echo "  container: ${CONTAINER_ID:0:12}"

# Step 2: Export container filesystem to a temp directory
ROOTFS_DIR=$(mktemp -d --suffix=.rootfs)
echo "Exporting filesystem to $ROOTFS_DIR..."
docker export "$CONTAINER_ID" | tar -xf - -C "$ROOTFS_DIR"
ROOTFS_SIZE=$(du -sm "$ROOTFS_DIR" | cut -f1)
echo "  extracted: ${ROOTFS_SIZE} MiB"

# Step 3 (optional): Inject init binary into the extracted rootfs
if [[ -n "$INJECT_INIT" ]]; then
  echo "Injecting init binary..."
  mkdir -p "$ROOTFS_DIR/opt/boilerhouse"
  cp "$INJECT_INIT" "$ROOTFS_DIR/opt/boilerhouse/init"
  chmod 755 "$ROOTFS_DIR/opt/boilerhouse/init"
  echo "  injected /opt/boilerhouse/init"
fi

# Step 4: Create ext4 image populated from the directory (no mount needed)
echo "Creating ext4 image from rootfs directory (this may take a moment)..."
mkfs.ext4 -F -L rootfs -d "$ROOTFS_DIR" "$OUTPUT_PATH" "${SIZE_MB}M"

# Step 5: Shrink to actual used size
echo "Shrinking filesystem..."
e2fsck -fy "$OUTPUT_PATH" >/dev/null 2>&1 || true
resize2fs -M "$OUTPUT_PATH" 2>/dev/null

FINAL_SIZE=$(stat --format=%s "$OUTPUT_PATH" 2>/dev/null || stat -f%z "$OUTPUT_PATH")
FINAL_MB=$((FINAL_SIZE / 1048576))
echo ""
echo "Done! rootfs at $OUTPUT_PATH (${FINAL_MB} MiB)"
