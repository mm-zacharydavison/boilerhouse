import { join } from "node:path";
import {
	mkdirSync,
	existsSync,
	copyFileSync,
	writeFileSync,
	readFileSync,
	statSync,
} from "node:fs";
import { ArtifactError } from "./errors";
import type { Manifest, ArtifactRef } from "./types";

/** Content-addressable store for built rootfs artifacts. */
export class ArtifactStore {
	constructor(private readonly basePath: string) {
		mkdirSync(basePath, { recursive: true });
	}

	/**
	 * Store a rootfs image and its manifest. The file is hashed with SHA-256
	 * and placed in `<basePath>/<hash>/rootfs.ext4` alongside `manifest.json`.
	 *
	 * If an artifact with the same hash already exists, the existing ref is returned.
	 */
	async store(
		rootfsPath: string,
		partial: Omit<Manifest, "hash" | "sizeBytes">,
	): Promise<ArtifactRef> {
		const hash = await this.hashFile(rootfsPath);
		const artifactDir = join(this.basePath, hash);

		const destRootfs = join(artifactDir, "rootfs.ext4");
		const destManifest = join(artifactDir, "manifest.json");

		// Idempotent: if the hash directory already exists, return the existing artifact
		if (existsSync(destManifest)) {
			return this.buildRef(hash, destRootfs, destManifest);
		}

		const sizeBytes = statSync(rootfsPath).size;

		const manifest: Manifest = {
			...partial,
			hash,
			sizeBytes,
		};

		try {
			mkdirSync(artifactDir, { recursive: true });
			copyFileSync(rootfsPath, destRootfs);
			writeFileSync(destManifest, JSON.stringify(manifest, null, 2));
		} catch (err) {
			throw new ArtifactError(
				`Failed to store artifact: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		return { hash, rootfsPath: destRootfs, manifestPath: destManifest, manifest };
	}

	/**
	 * Retrieve a previously stored artifact by its SHA-256 hash.
	 * Returns `null` if no artifact with that hash exists.
	 */
	getArtifact(hash: string): ArtifactRef | null {
		const manifestPath = join(this.basePath, hash, "manifest.json");
		if (!existsSync(manifestPath)) {
			return null;
		}

		const rootfsPath = join(this.basePath, hash, "rootfs.ext4");
		return this.buildRef(hash, rootfsPath, manifestPath);
	}

	private buildRef(hash: string, rootfsPath: string, manifestPath: string): ArtifactRef {
		try {
			const raw = readFileSync(manifestPath, "utf-8");
			const manifest: Manifest = JSON.parse(raw);
			return { hash, rootfsPath, manifestPath, manifest };
		} catch (err) {
			throw new ArtifactError(
				`Failed to read manifest for ${hash}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	private async hashFile(filePath: string): Promise<string> {
		const hasher = new Bun.CryptoHasher("sha256");
		const file = Bun.file(filePath);
		const stream = file.stream();

		for await (const chunk of stream) {
			hasher.update(chunk);
		}

		return hasher.digest("hex");
	}
}
