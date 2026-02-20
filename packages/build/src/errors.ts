/** Base error for all build pipeline errors. */
export class BuildError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BuildError";
	}
}

/** Error during OCI image pull, export, or build. */
export class OciError extends BuildError {
	constructor(
		message: string,
		public readonly exitCode?: number,
	) {
		super(message);
		this.name = "OciError";
	}
}

/** Error during rootfs creation or init injection. */
export class RootfsError extends BuildError {
	constructor(message: string) {
		super(message);
		this.name = "RootfsError";
	}
}

/** Error during artifact storage or retrieval. */
export class ArtifactError extends BuildError {
	constructor(message: string) {
		super(message);
		this.name = "ArtifactError";
	}
}
