import type { ContainerCreateSpec, ContainerInspect, ExecResult } from "./client";

/** Result of a checkpoint operation performed by a backend. */
export interface CheckpointResult {
	/** Absolute path to the stored checkpoint archive. */
	archivePath: string;
	/** Hex-encoded HMAC-SHA256 of the archive, if signing is enabled. */
	hmac?: string;
	/** Container ports extracted from the checkpoint's config.dump. */
	exposedPorts: number[];
}

/** Result of an ensureImage operation. */
export interface EnsureImageResult {
	/** The resolved image reference. */
	image: string;
	/** What action was taken: "cached" (already present), "pulled", or "built". */
	action: "cached" | "pulled" | "built";
}

/** Backend system information. */
export interface BackendInfo {
	/** Whether CRIU is available for checkpoint/restore. */
	criuEnabled: boolean;
	/** Podman or daemon version string. */
	version: string;
	/** Host CPU architecture (e.g. "x86_64", "aarch64"). */
	architecture: string;
}

/**
 * Abstraction over container lifecycle operations.
 *
 * Implemented by `DaemonBackend`, which talks to `boilerhoused` over a Unix socket.
 */
export interface ContainerBackend {
	/** Fetch backend system information. */
	info(): Promise<BackendInfo>;

	/**
	 * Ensure the workload image is available.
	 * Pulls from registry or builds from Dockerfile as needed.
	 */
	ensureImage(
		image: { ref?: string; dockerfile?: string },
		workload: { name: string; version: string },
	): Promise<EnsureImageResult>;

	/** Create a container from a spec. Returns the container ID. */
	createContainer(spec: ContainerCreateSpec): Promise<string>;

	/** Start a container by name or ID. */
	startContainer(id: string): Promise<void>;

	/** Inspect a container. Returns the container metadata. */
	inspectContainer(id: string): Promise<ContainerInspect>;

	/** Force remove a container. Idempotent. */
	removeContainer(id: string): Promise<void>;

	/**
	 * Checkpoint a container and store the archive.
	 * Handles archive rewriting, HMAC signing, and file I/O.
	 */
	checkpoint(
		id: string,
		archiveDir: string,
	): Promise<CheckpointResult>;

	/**
	 * Restore a container from a checkpoint archive.
	 * Handles HMAC verification and archive reading.
	 *
	 * @returns The new container ID.
	 */
	restore(
		archivePath: string,
		hmac: string | undefined,
		name: string,
		publishPorts?: string[],
	): Promise<string>;

	/**
	 * Execute a command inside a running container.
	 */
	exec(id: string, cmd: string[]): Promise<ExecResult>;

	/**
	 * List container IDs managed by this backend.
	 */
	listContainers(): Promise<string[]>;

	/**
	 * Fetch recent stdout/stderr logs from a container.
	 *
	 * @param tail - Number of most recent lines to return.
	 */
	logs(id: string, tail?: number): Promise<string>;
}
