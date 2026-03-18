/**
 * Platform-aware default paths for Boilerhouse.
 *
 * macOS: user-local paths under ~/.local/share/boilerhouse/
 * Linux: system paths under /var/run/ and /var/lib/
 */

const IS_MACOS = process.platform === "darwin";
const HOME = process.env.HOME ?? "/tmp";

/** Default path for the boilerhouse-podmand runtime socket. */
export const DEFAULT_RUNTIME_SOCKET = IS_MACOS
	? `${HOME}/.local/share/boilerhouse/runtime.sock`
	: "/var/run/boilerhouse/runtime.sock";

/**
 * Default path for the podman API socket.
 *
 * On macOS the socket is discovered at runtime via `podman machine inspect`,
 * so there is no static default.
 */
export const DEFAULT_PODMAN_SOCKET: string | undefined = IS_MACOS
	? undefined
	: "/var/run/boilerhouse/podman.sock";

/** Default path for CRIU checkpoint/snapshot archives. */
export const DEFAULT_SNAPSHOT_DIR = IS_MACOS
	? `${HOME}/.local/share/boilerhouse/snapshots`
	: "/var/lib/boilerhouse/snapshots";
