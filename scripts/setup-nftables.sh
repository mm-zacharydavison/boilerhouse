#!/usr/bin/env bash
set -euo pipefail

# Installs boilerhouse nftables rules for container network isolation.
#
# Usage:
#   sudo scripts/setup-nftables.sh
#   sudo scripts/setup-nftables.sh --dry-run
#
# What this script does:
#   1. Installs nftables via the system package manager (if not already present)
#   2. Copies deploy/nftables-boilerhouse.conf to /etc/nftables.d/boilerhouse.conf
#   3. Loads the rules immediately via `nft -f`
#   4. Configures nftables.service to load rules on boot (includes /etc/nftables.d/*.conf)
#
# The rules block:
#   - Cross-container traffic (10.89.0.0/16 → 10.89.0.0/16)
#   - Container-to-host new connections (10.89.0.0/16 → host INPUT)
#
# WARNING: These rules modify host-level firewall state. Review
#          deploy/nftables-boilerhouse.conf before applying in production.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONF_SRC="${REPO_ROOT}/deploy/nftables-boilerhouse.conf"
CONF_DST="/etc/nftables.d/boilerhouse.conf"
NFTABLES_MAIN="/etc/nftables.conf"

DRY_RUN=false

for arg in "$@"; do
	case "$arg" in
		--dry-run)
			DRY_RUN=true
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

info() {
	echo "==> $*"
}

warn() {
	echo "WARNING: $*" >&2
}

fail() {
	echo "ERROR: $*" >&2
	exit 1
}

if [ "$(id -u)" -ne 0 ]; then
	fail "This script must be run as root (use sudo)."
fi

if [ ! -f "${CONF_SRC}" ]; then
	fail "Source config not found: ${CONF_SRC}"
fi

# ── Detect distro ─────────────────────────────────────────────────────────────

if [ -f /etc/os-release ]; then
	# shellcheck disable=SC1091
	. /etc/os-release
	DISTRO="${ID}"
else
	fail "Cannot detect distribution (no /etc/os-release)."
fi

info "Detected distro: ${DISTRO}"

# ── Install nftables ──────────────────────────────────────────────────────────

if ! command -v nft &>/dev/null; then
	info "Installing nftables..."
	case "${DISTRO}" in
		ubuntu|debian|pop)
			run apt-get update -qq || warn "apt-get update had errors (continuing anyway)"
			run apt-get install -y -qq nftables
			;;
		fedora|rhel|centos|rocky|almalinux)
			run dnf install -y nftables
			;;
		arch|manjaro)
			run pacman -S --noconfirm --needed nftables
			;;
		*)
			warn "Unsupported distro '${DISTRO}'. Install nftables manually."
			;;
	esac
else
	info "nftables already installed."
fi

if ! command -v nft &>/dev/null && [ "$DRY_RUN" = false ]; then
	fail "nft not found on PATH after installation."
fi

# ── Install rules ─────────────────────────────────────────────────────────────

info "Installing boilerhouse nftables rules to ${CONF_DST}..."
run mkdir -p "$(dirname "${CONF_DST}")"
run cp "${CONF_SRC}" "${CONF_DST}"
run chmod 644 "${CONF_DST}"

# ── Enable /etc/nftables.d/ includes in the main config ──────────────────────
#
# Most distros ship /etc/nftables.conf with an `include "/etc/nftables.d/*.conf"`
# line (or similar). If it's missing, add it.

if [ "$DRY_RUN" = false ] && [ -f "${NFTABLES_MAIN}" ]; then
	if ! grep -q 'nftables\.d' "${NFTABLES_MAIN}" 2>/dev/null; then
		info "Adding include for /etc/nftables.d/*.conf to ${NFTABLES_MAIN}..."
		echo '' >> "${NFTABLES_MAIN}"
		echo '# Boilerhouse drop-in rules' >> "${NFTABLES_MAIN}"
		echo 'include "/etc/nftables.d/*.conf"' >> "${NFTABLES_MAIN}"
	fi
elif [ "$DRY_RUN" = true ]; then
	echo "[dry-run] would ensure /etc/nftables.d/*.conf is included in ${NFTABLES_MAIN}"
fi

# ── Load rules immediately ────────────────────────────────────────────────────

info "Loading rules..."

# Remove any previously loaded boilerhouse table before reloading
if [ "$DRY_RUN" = false ]; then
	nft delete table inet boilerhouse 2>/dev/null || true
	nft -f "${CONF_DST}"
	echo "  Rules loaded."
else
	echo "[dry-run] nft delete table inet boilerhouse (if exists)"
	echo "[dry-run] nft -f ${CONF_DST}"
fi

# ── Enable and start nftables.service ────────────────────────────────────────

if command -v systemctl &>/dev/null; then
	info "Enabling nftables.service for persistence across reboots..."
	run systemctl enable nftables
	run systemctl restart nftables
else
	warn "systemctl not found — nftables rules will not persist across reboots."
	warn "Add 'nft -f ${CONF_DST}' to your init scripts manually."
fi

# ── Verify ────────────────────────────────────────────────────────────────────

if [ "$DRY_RUN" = false ]; then
	if nft list table inet boilerhouse &>/dev/null; then
		info "Verification passed: inet boilerhouse table is active."
	else
		warn "Could not verify that inet boilerhouse table was loaded."
	fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
info "nftables setup complete."
echo ""
echo "Active rules:"
if [ "$DRY_RUN" = false ]; then
	nft list table inet boilerhouse 2>/dev/null || echo "  (table not loaded)"
else
	echo "  [dry-run] skipped"
fi
echo ""
echo "To remove the rules:"
echo "  sudo nft delete table inet boilerhouse"
echo "  sudo rm ${CONF_DST}"
