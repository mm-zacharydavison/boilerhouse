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
}
