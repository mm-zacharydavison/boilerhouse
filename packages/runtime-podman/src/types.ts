export interface PodmanConfig {
	/**
	 * Directory for storing checkpoint archives.
	 * @default "/var/lib/boilerhouse/snapshots"
	 * @example "/data/snapshots"
	 */
	snapshotDir: string;

	/**
	 * Path to the rootful podman API socket.
	 * @default "/run/boilerhouse/podman.sock"
	 * @example "/run/podman/podman.sock"
	 */
	socketPath?: string;

	/**
	 * Base directory for resolving workload Dockerfile paths.
	 * Required when workloads use `image.dockerfile` instead of `image.ref`.
	 * @example "/home/user/boilerhouse/workloads"
	 */
	workloadsDir?: string;

	/**
	 * Forward proxy address to inject as HTTP_PROXY/http_proxy into containers.
	 * Only injected when the workload has network access (not "none").
	 * @example "http://host.containers.internal:38080"
	 */
	proxyAddress?: string;
}
