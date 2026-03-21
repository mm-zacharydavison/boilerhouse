#!/usr/bin/env bash
# Boilerhouse host installer
#
# Installs all host dependencies, deploys boilerhouse-podmand as a systemd
# service, and generates secrets. Run as root on a fresh Ubuntu/Debian VM.
#
# After this script completes, the podmand daemon is running and you can
# either:
#   1. Run the boilerhouse API via Docker (see docs/deploy-vm.md)
#   2. Run it directly: cd /opt/boilerhouse && bun apps/api/src/server.ts
#
# Usage:
#   curl -fsSL <raw-url>/deploy/install.sh | bash
#   # or
#   ssh root@<ip> 'bash -s' < deploy/install.sh
#
# Options (environment variables):
#   BOILERHOUSE_VERSION   Git ref to checkout (default: main)
#   BOILERHOUSE_REPO      Git clone URL (default: prompts if not set)
#   BOILERHOUSE_DIR       Install directory (default: /opt/boilerhouse)
#   SKIP_FIREWALL         Set to 1 to skip nftables setup
#
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────

INSTALL_DIR="${BOILERHOUSE_DIR:-/opt/boilerhouse}"
VERSION="${BOILERHOUSE_VERSION:-main}"
CONFIG_DIR="/etc/boilerhouse"
DATA_DIR="/var/lib/boilerhouse"

log() { echo "==> $*"; }
warn() { echo "WARNING: $*" >&2; }

# ── Preflight ─────────────────────────────────────────────────────────────

if [ "$(id -u)" -ne 0 ]; then
  echo "This script must be run as root." >&2
  exit 1
fi

if ! grep -qiE 'ubuntu|debian' /etc/os-release 2>/dev/null; then
  warn "This script is tested on Ubuntu/Debian. Other distros may need manual adjustments."
fi

# ── 1. System packages ───────────────────────────────────────────────────

log "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq podman crun criu nftables curl unzip git

# ── 2. Bun ────────────────────────────────────────────────────────────────

if command -v bun &>/dev/null; then
  log "Bun already installed: $(bun --version)"
else
  log "Installing Bun"
  curl -fsSL https://bun.sh/install | bash
  # Link into PATH for systemd and other users
  ln -sf /root/.bun/bin/bun /usr/local/bin/bun
  log "Bun installed: $(bun --version)"
fi

# ── 3. Verify CRIU ────────────────────────────────────────────────────────

log "Verifying CRIU"
if criu check 2>/dev/null; then
  echo "  CRIU check passed"
else
  warn "criu check failed — checkpoint/restore may not work. Check kernel config."
fi

if podman info 2>/dev/null | grep -qi "criuEnabled.*true"; then
  echo "  Podman reports CRIU enabled"
else
  warn "Podman does not report CRIU as enabled"
fi

# ── 4. System user ────────────────────────────────────────────────────────

if id boilerhouse &>/dev/null; then
  log "User 'boilerhouse' already exists"
else
  log "Creating 'boilerhouse' system user"
  useradd --system --create-home --shell /usr/sbin/nologin boilerhouse
fi

# ── 5. Directories ────────────────────────────────────────────────────────

log "Creating directories"
mkdir -p "$DATA_DIR"/{data,snapshots} "$CONFIG_DIR" /run/boilerhouse
chown boilerhouse:boilerhouse "$DATA_DIR/data"
chmod 700 "$DATA_DIR/snapshots"

# ── 6. Deploy code ────────────────────────────────────────────────────────

if [ -d "$INSTALL_DIR/.git" ]; then
  log "Updating existing install at $INSTALL_DIR"
  cd "$INSTALL_DIR"
  git fetch origin
  git checkout "$VERSION"
  git pull --ff-only origin "$VERSION" 2>/dev/null || true
else
  if [ -z "${BOILERHOUSE_REPO:-}" ]; then
    echo ""
    echo "No existing install found at $INSTALL_DIR."
    echo "Set BOILERHOUSE_REPO to the git clone URL, or clone manually first."
    echo ""
    echo "Example:"
    echo "  BOILERHOUSE_REPO=git@github.com:org/boilerhouse.git bash deploy/install.sh"
    echo "  # or"
    echo "  git clone <url> $INSTALL_DIR && bash $INSTALL_DIR/deploy/install.sh"
    exit 1
  fi
  log "Cloning boilerhouse ($VERSION) to $INSTALL_DIR"
  git clone --branch "$VERSION" "$BOILERHOUSE_REPO" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
log "Installing JS dependencies"
bun install --frozen-lockfile

# ── 7. Generate secrets ──────────────────────────────────────────────────

PODMAND_ENV="$CONFIG_DIR/podmand.env"
API_ENV="$CONFIG_DIR/api.env"

if [ -f "$PODMAND_ENV" ]; then
  log "podmand.env already exists — skipping secret generation"
else
  log "Generating secrets"

  HMAC_KEY=$(openssl rand -hex 32)
  SECRET_KEY=$(openssl rand -hex 32)

  cat > "$PODMAND_ENV" <<EOF
PODMAN_SOCKET=/run/boilerhouse/podman.sock
LISTEN_SOCKET=/run/boilerhouse/runtime.sock
SNAPSHOT_DIR=$DATA_DIR/snapshots
HMAC_KEY=$HMAC_KEY
WORKLOADS_DIR=$INSTALL_DIR/workloads
EOF

  cat > "$API_ENV" <<EOF
RUNTIME_TYPE=podman
RUNTIME_SOCKET=/run/boilerhouse/runtime.sock
SNAPSHOT_DIR=$DATA_DIR/snapshots
STORAGE_PATH=$DATA_DIR/data
DB_PATH=$DATA_DIR/boilerhouse.db
BOILERHOUSE_SECRET_KEY=$SECRET_KEY
LISTEN_HOST=127.0.0.1
PORT=3000
METRICS_PORT=9464
METRICS_HOST=127.0.0.1
WORKLOADS_DIR=$INSTALL_DIR/workloads
MAX_INSTANCES=100
EOF

  chmod 600 "$PODMAND_ENV" "$API_ENV"
  log "Secrets written to $CONFIG_DIR/"
fi

# ── 8. Install podmand systemd service ────────────────────────────────────

log "Installing boilerhouse-podmand systemd service"

# Write the unit file with EnvironmentFile baked in
cat > /etc/systemd/system/boilerhouse-podmand@.service <<UNIT
[Unit]
Description=Boilerhouse Runtime Daemon (podman + CRIU)
After=network.target

[Service]
Type=simple
UMask=0117
EnvironmentFile=$PODMAND_ENV
ExecStartPre=/bin/mkdir -p /run/boilerhouse $DATA_DIR/snapshots
ExecStart=/usr/local/bin/bun $INSTALL_DIR/apps/boilerhouse-podmand/src/main.ts
ExecStartPost=/bin/sh -c 'until [ -S /run/boilerhouse/runtime.sock ]; do sleep 0.1; done; chgrp %i /run/boilerhouse/runtime.sock; chmod 660 /run/boilerhouse/runtime.sock'
Restart=on-failure
RestartSec=5

# Security hardening
CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_SYS_PTRACE CAP_NET_ADMIN CAP_SYS_CHROOT CAP_CHOWN CAP_DAC_READ_SEARCH CAP_FOWNER CAP_KILL
ProtectSystem=strict
PrivateTmp=true
ReadWritePaths=/run/boilerhouse $DATA_DIR /var/lib/containers /var/run/containers /tmp

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now boilerhouse-podmand@boilerhouse

# Wait for the socket
log "Waiting for podmand socket..."
for _ in $(seq 1 30); do
  [ -S /run/boilerhouse/runtime.sock ] && break
  sleep 1
done

if [ -S /run/boilerhouse/runtime.sock ]; then
  log "podmand is running"
else
  warn "Runtime socket not found after 30s. Check: journalctl -u boilerhouse-podmand@boilerhouse"
fi

# ── 9. Firewall (optional) ───────────────────────────────────────────────

if [ "${SKIP_FIREWALL:-0}" = "1" ]; then
  log "Skipping firewall setup (SKIP_FIREWALL=1)"
else
  log "Configuring nftables firewall"
  cp "$INSTALL_DIR/deploy/nftables.conf" /etc/nftables.conf
  systemctl enable --now nftables
  nft -f /etc/nftables.conf
fi

# ── Done ──────────────────────────────────────────────────────────────────

echo ""
echo "============================================"
echo "  Boilerhouse host setup complete"
echo "============================================"
echo ""
echo "  podmand:    systemctl status boilerhouse-podmand@boilerhouse"
echo "  socket:     /run/boilerhouse/runtime.sock"
echo "  config:     $CONFIG_DIR/"
echo "  data:       $DATA_DIR/"
echo "  code:       $INSTALL_DIR/"
echo ""
echo "  To run the API directly:"
echo "    source $API_ENV && cd $INSTALL_DIR && bun apps/api/src/server.ts"
echo ""
echo "  To run the API via Docker (in your app's docker-compose):"
echo "    See $INSTALL_DIR/docs/deploy-vm.md"
echo ""
