export interface PodmanConfig {
	/**
	 * Directory for storing checkpoint archives.
	 * @default "/var/lib/boilerhouse/snapshots"
	 * @example "/data/snapshots"
	 */
	snapshotDir: string;

	/**
	 * Path to the `boilerhoused` runtime socket.
	 * @default "/run/boilerhouse/runtime.sock"
	 * @example "/run/boilerhouse/runtime.sock"
	 */
	socketPath?: string;

	/**
	 * Forward proxy address to inject as HTTP_PROXY/http_proxy into containers.
	 * Only injected when the workload has network access (not "none").
	 * @example "http://host.containers.internal:38080"
	 */
	proxyAddress?: string;
}
