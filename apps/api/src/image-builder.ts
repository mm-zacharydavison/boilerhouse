import { dirname, resolve } from "node:path";
import { existsSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Workload } from "@boilerhouse/core";
import { resolveImagePath } from "@boilerhouse/core";
import {
	pullImage as defaultPullImage,
	exportFilesystem as defaultExportFilesystem,
	buildImage as defaultBuildImage,
	createExt4 as defaultCreateExt4,
	injectInit as defaultInjectInit,
} from "@boilerhouse/build";
import type { InjectConfig } from "@boilerhouse/build";

/** Injectable build functions for testing. */
export interface ImageBuildFns {
	pullImage: (ref: string, onLog?: (line: string) => void) => Promise<void>;
	exportFilesystem: (ref: string, tarPath: string) => Promise<void>;
	buildImage: (dockerfile: string, tarPath: string, onLog?: (line: string) => void) => Promise<void>;
	createExt4: (tarPath: string, outputPath: string, sizeGb: number, onLog?: (line: string) => void) => Promise<void>;
	injectInit: (ext4Path: string, config: InjectConfig, onLog?: (line: string) => void) => Promise<void>;
}

/** Ensures rootfs images exist before VM creation. */
export interface ImageBuilder {
	ensureRootfs(workload: Workload, onLog?: (line: string) => void): Promise<void>;
}

export interface OciImageBuilderOptions {
	/** Injectable build functions for testing. */
	fns?: ImageBuildFns;
	/**
	 * Base directory for workload TOML files.
	 * Required when using `image.dockerfile` — Dockerfile paths are resolved relative to this.
	 */
	workloadsDir?: string;
	/**
	 * Paths to guest-init binaries injected into every rootfs.
	 * When set, `/opt/boilerhouse/{init,idle-agent,overlay-init.sh}` are
	 * copied into the ext4 image after creation.
	 */
	initConfig?: InjectConfig;
}

const DEFAULT_FNS: ImageBuildFns = {
	pullImage: defaultPullImage,
	exportFilesystem: defaultExportFilesystem,
	buildImage: defaultBuildImage,
	createExt4: defaultCreateExt4,
	injectInit: defaultInjectInit,
};

/**
 * Builds rootfs ext4 images from OCI images or Dockerfiles on demand.
 *
 * Path conventions (shared with FirecrackerRuntime via `resolveImagePath`):
 * - `image.ref = "alpine:latest"` → `<imagesDir>/alpine/latest/rootfs.ext4`
 * - `image.dockerfile` on workload `minimal:0.1.0` → `<imagesDir>/_builds/minimal/0.1.0/rootfs.ext4`
 */
export class OciImageBuilder implements ImageBuilder {
	private readonly fns: ImageBuildFns;
	private readonly workloadsDir?: string;
	private readonly initConfig?: InjectConfig;

	constructor(
		private readonly imagesDir: string,
		options?: OciImageBuilderOptions,
	) {
		this.fns = options?.fns ?? DEFAULT_FNS;
		this.workloadsDir = options?.workloadsDir;
		this.initConfig = options?.initConfig;
	}

	async ensureRootfs(workload: Workload, onLog?: (line: string) => void): Promise<void> {
		const rootfsPath = resolveImagePath(this.imagesDir, workload);
		const log = onLog ?? (() => {});

		if (existsSync(rootfsPath)) return;

		const imageSource = workload.image.ref ?? workload.image.dockerfile!;
		log(`Building rootfs for '${imageSource}'...`);

		mkdirSync(dirname(rootfsPath), { recursive: true });

		const tmpDir = mkdtempSync(join(tmpdir(), "boilerhouse-image-build-"));

		try {
			const tarPath = join(tmpDir, "filesystem.tar");

			if (workload.image.ref) {
				log(`Pulling image ${workload.image.ref}...`);
				await this.fns.pullImage(workload.image.ref, onLog);
				log("Exporting filesystem...");
				await this.fns.exportFilesystem(workload.image.ref, tarPath);
			} else if (workload.image.dockerfile) {
				if (!this.workloadsDir) {
					throw new Error(
						"workloadsDir must be configured to build from Dockerfiles",
					);
				}
				const dockerfilePath = resolve(this.workloadsDir, workload.image.dockerfile);
				log(`Building from Dockerfile: ${workload.image.dockerfile}...`);
				await this.fns.buildImage(dockerfilePath, tarPath, onLog);
			}

			log("Creating ext4 image...");
			await this.fns.createExt4(tarPath, rootfsPath, workload.resources.disk_gb, onLog);

			if (this.initConfig) {
				log("Injecting init binaries...");
				await this.fns.injectInit(rootfsPath, this.initConfig, onLog);
			}

			log(`Rootfs ready at ${rootfsPath}`);
		} catch (err) {
			// Clean up partial rootfs on failure
			try {
				rmSync(rootfsPath, { force: true });
			} catch {}
			throw err;
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	}
}
