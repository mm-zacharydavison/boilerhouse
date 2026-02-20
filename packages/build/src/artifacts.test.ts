import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { ArtifactStore } from "./artifacts";
import type { Manifest } from "./types";

describe("ArtifactStore", () => {
	let baseDir: string;
	let store: ArtifactStore;

	beforeEach(() => {
		baseDir = mkdtempSync(join(tmpdir(), "boilerhouse-artifacts-"));
		store = new ArtifactStore(baseDir);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	function createDummyRootfs(content: string): string {
		const path = join(baseDir, "dummy-rootfs.ext4");
		writeFileSync(path, content);
		return path;
	}

	const baseManifest: Omit<Manifest, "hash" | "sizeBytes"> = {
		imageSource: "alpine:3.19",
		workloadName: "test-workload",
		workloadVersion: "1.0.0",
		buildDate: "2026-01-01T00:00:00.000Z",
		diskGb: 2,
	};

	test("stores artifact in content-addressable directory", async () => {
		const rootfsPath = createDummyRootfs("rootfs-content-123");
		const ref = await store.store(rootfsPath, baseManifest);

		expect(ref.hash).toMatch(/^[a-f0-9]{64}$/);
		expect(ref.rootfsPath).toBe(join(baseDir, ref.hash, "rootfs.ext4"));
		expect(ref.manifestPath).toBe(join(baseDir, ref.hash, "manifest.json"));

		// Verify the rootfs was copied
		const storedContent = readFileSync(ref.rootfsPath, "utf-8");
		expect(storedContent).toBe("rootfs-content-123");
	});

	test("manifest.json contains image ref, size, hash, and build date", async () => {
		const rootfsPath = createDummyRootfs("manifest-test-content");
		const ref = await store.store(rootfsPath, baseManifest);

		const manifestJson = readFileSync(ref.manifestPath, "utf-8");
		const manifest: Manifest = JSON.parse(manifestJson);

		expect(manifest.imageSource).toBe("alpine:3.19");
		expect(manifest.workloadName).toBe("test-workload");
		expect(manifest.workloadVersion).toBe("1.0.0");
		expect(manifest.buildDate).toBe("2026-01-01T00:00:00.000Z");
		expect(manifest.diskGb).toBe(2);
		expect(manifest.hash).toMatch(/^[a-f0-9]{64}$/);
		expect(manifest.sizeBytes).toBe(Buffer.byteLength("manifest-test-content"));
	});

	test("duplicate builds produce the same hash (idempotent)", async () => {
		const rootfsPath1 = createDummyRootfs("identical-content");
		const ref1 = await store.store(rootfsPath1, baseManifest);

		// Create a second dummy with the same content
		const rootfsPath2 = createDummyRootfs("identical-content");
		const ref2 = await store.store(rootfsPath2, baseManifest);

		expect(ref1.hash).toBe(ref2.hash);
		expect(ref1.rootfsPath).toBe(ref2.rootfsPath);
	});

	test("different content produces different hashes", async () => {
		const rootfsPath1 = createDummyRootfs("content-a");
		const ref1 = await store.store(rootfsPath1, baseManifest);

		const rootfsPath2 = createDummyRootfs("content-b");
		const ref2 = await store.store(rootfsPath2, baseManifest);

		expect(ref1.hash).not.toBe(ref2.hash);
	});

	test("getArtifact returns null for unknown hashes", () => {
		const result = store.getArtifact("0000000000000000000000000000000000000000000000000000000000000000");
		expect(result).toBeNull();
	});

	test("getArtifact retrieves previously stored artifact", async () => {
		const rootfsPath = createDummyRootfs("retrievable-content");
		const stored = await store.store(rootfsPath, baseManifest);

		const retrieved = store.getArtifact(stored.hash);
		expect(retrieved).not.toBeNull();
		expect(retrieved!.hash).toBe(stored.hash);
		expect(retrieved!.rootfsPath).toBe(stored.rootfsPath);
		expect(retrieved!.manifest.imageSource).toBe("alpine:3.19");
		expect(retrieved!.manifest.sizeBytes).toBe(stored.manifest.sizeBytes);
	});

	test("creates basePath directory if it does not exist", async () => {
		const nestedDir = join(baseDir, "nested", "deep", "path");
		const nestedStore = new ArtifactStore(nestedDir);

		const rootfsPath = createDummyRootfs("nested-test");
		const ref = await nestedStore.store(rootfsPath, baseManifest);

		expect(ref.rootfsPath).toContain(nestedDir);
		const content = readFileSync(ref.rootfsPath, "utf-8");
		expect(content).toBe("nested-test");
	});
});
