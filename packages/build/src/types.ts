/** Metadata stored alongside a built rootfs artifact. */
export interface Manifest {
	/**
	 * OCI image reference or Dockerfile path used as the source.
	 * @example "alpine:3.19" or "./Dockerfile"
	 */
	imageSource: string;
	workloadName: string;
	workloadVersion: string;
	/** Size of the rootfs.ext4 file in bytes. */
	sizeBytes: number;
	/** SHA-256 hex digest of the rootfs.ext4 file. */
	hash: string;
	/** ISO 8601 build timestamp. */
	buildDate: string;
	/** Disk size in GB as specified in the workload. */
	diskGb: number;
}

/** Reference to a stored artifact in content-addressable storage. */
export interface ArtifactRef {
	/** SHA-256 hex digest of the rootfs.ext4 file. */
	hash: string;
	/** Absolute path to `<basePath>/<hash>/rootfs.ext4`. */
	rootfsPath: string;
	/** Absolute path to `<basePath>/<hash>/manifest.json`. */
	manifestPath: string;
	manifest: Manifest;
}

/** Paths to binaries that get injected into the rootfs. */
export interface InjectConfig {
	/** Copied to `/opt/boilerhouse/init` inside the rootfs. */
	initBinaryPath: string;
	/** Copied to `/opt/boilerhouse/idle-agent` inside the rootfs. */
	idleAgentPath: string;
	/** Copied to `/opt/boilerhouse/overlay-init.sh` inside the rootfs. */
	overlayInitPath: string;
}
