import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { parseWorkload } from "@boilerhouse/core";
import { BuildError } from "./errors";
import { pullImage, exportFilesystem, buildImage } from "./oci";
import { createExt4, injectInit } from "./rootfs";
import { ArtifactStore } from "./artifacts";
import type { InjectConfig, ArtifactRef, Manifest } from "./types";

/**
 * Build a rootfs artifact from a workload TOML file.
 *
 * Pipeline:
 * 1. Parse workload TOML
 * 2. Pull OCI image or build from Dockerfile
 * 3. Export filesystem to tarball
 * 4. Create ext4 image from tarball
 * 5. Inject init binaries
 * 6. Store in content-addressable artifact directory
 *
 * @param workloadPath - Absolute path to the workload TOML file
 * @param outputDir - Base directory for content-addressable artifact storage
 * @param config - Paths to init binaries to inject
 * @returns Reference to the stored artifact
 * @throws {BuildError} if any step in the pipeline fails
 */
export async function build(
	workloadPath: string,
	outputDir: string,
	config: InjectConfig,
): Promise<ArtifactRef> {
	const toml = await Bun.file(workloadPath).text();
	const workload = parseWorkload(toml);

	const tmpDir = mkdtempSync(join(tmpdir(), "boilerhouse-build-"));

	try {
		const tarPath = join(tmpDir, "filesystem.tar");
		const ext4Path = join(tmpDir, "rootfs.ext4");

		// Export OCI filesystem to tarball
		if (workload.image.ref) {
			await pullImage(workload.image.ref);
			await exportFilesystem(workload.image.ref, tarPath);
		} else if (workload.image.dockerfile) {
			const dockerfilePath = resolve(dirname(workloadPath), workload.image.dockerfile);
			await buildImage(dockerfilePath, tarPath);
		} else {
			throw new BuildError("Workload must specify either image.ref or image.dockerfile");
		}

		// Build ext4 and inject init
		await createExt4(tarPath, ext4Path, workload.resources.disk_gb);
		await injectInit(ext4Path, config);

		// Determine image source for manifest
		const imageSource = workload.image.ref ?? workload.image.dockerfile!;

		const partialManifest: Omit<Manifest, "hash" | "sizeBytes"> = {
			imageSource,
			workloadName: workload.workload.name,
			workloadVersion: workload.workload.version,
			buildDate: new Date().toISOString(),
			diskGb: workload.resources.disk_gb,
		};

		// Store in content-addressable storage
		const store = new ArtifactStore(outputDir);
		return await store.store(ext4Path, partialManifest);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
}
