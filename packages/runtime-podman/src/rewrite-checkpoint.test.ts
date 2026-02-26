import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rewriteCheckpointPorts } from "./runtime";

/**
 * Creates a fake checkpoint tar.gz archive containing a config.dump
 * with the given port mappings.
 */
async function createFakeCheckpoint(
	portMappings?: Array<{
		container_port: number;
		host_port: number;
		host_ip?: string;
		protocol?: string;
	}>,
): Promise<Buffer> {
	const tmpDir = mkdtempSync(join(tmpdir(), "bh-test-checkpoint-"));
	const contentDir = join(tmpDir, "content");
	const archivePath = join(tmpDir, "checkpoint.tar.gz");

	await Bun.$`mkdir -p ${contentDir}`.quiet();

	const config: Record<string, unknown> = {
		rootfsImageName: "docker.io/library/python:3-alpine",
	};

	if (portMappings) {
		config.newPortMappings = portMappings;
	}

	await Bun.write(join(contentDir, "config.dump"), JSON.stringify(config));

	// Add a dummy file to simulate other checkpoint content
	await Bun.write(join(contentDir, "spec.dump"), "{}");

	await Bun.$`tar -czf ${archivePath} -C ${contentDir} .`.quiet();

	const data = await Bun.file(archivePath).arrayBuffer();

	await Bun.$`rm -rf ${tmpDir}`.quiet().nothrow();

	return Buffer.from(data);
}

/**
 * Extracts config.dump from a checkpoint archive and parses it.
 */
async function extractConfigDump(
	archive: Buffer,
): Promise<Record<string, unknown>> {
	const tmpDir = mkdtempSync(join(tmpdir(), "bh-test-extract-"));
	const archivePath = join(tmpDir, "checkpoint.tar.gz");
	const extractDir = join(tmpDir, "extracted");

	await Bun.write(archivePath, archive);
	await Bun.$`mkdir -p ${extractDir}`.quiet();
	await Bun.$`tar -xzf ${archivePath} -C ${extractDir}`.quiet();

	const config = await Bun.file(join(extractDir, "config.dump")).json();

	await Bun.$`rm -rf ${tmpDir}`.quiet().nothrow();

	return config as Record<string, unknown>;
}

describe("rewriteCheckpointPorts", () => {
	test("zeroes out host ports and returns container ports", async () => {
		const archive = await createFakeCheckpoint([
			{ container_port: 8080, host_port: 32863, host_ip: "0.0.0.0", protocol: "tcp" },
		]);

		const result = await rewriteCheckpointPorts(archive);

		expect(result.containerPorts).toEqual([8080]);

		// Verify the archive was modified
		const config = await extractConfigDump(result.archive);
		const mappings = config.newPortMappings as Array<{
			container_port: number;
			host_port: number;
		}>;
		expect(mappings).toHaveLength(1);
		expect(mappings[0]!.container_port).toBe(8080);
		expect(mappings[0]!.host_port).toBe(0);
	});

	test("handles multiple port mappings", async () => {
		const archive = await createFakeCheckpoint([
			{ container_port: 8080, host_port: 32863, protocol: "tcp" },
			{ container_port: 9090, host_port: 32864, protocol: "tcp" },
		]);

		const result = await rewriteCheckpointPorts(archive);

		expect(result.containerPorts).toEqual([8080, 9090]);

		const config = await extractConfigDump(result.archive);
		const mappings = config.newPortMappings as Array<{
			container_port: number;
			host_port: number;
		}>;
		expect(mappings).toHaveLength(2);
		expect(mappings[0]!.host_port).toBe(0);
		expect(mappings[1]!.host_port).toBe(0);
	});

	test("returns original archive when no port mappings exist", async () => {
		const archive = await createFakeCheckpoint();

		const result = await rewriteCheckpointPorts(archive);

		expect(result.containerPorts).toEqual([]);
		// Archive is returned as-is (no modification needed)
		expect(result.archive).toBe(archive);
	});

	test("returns original archive when newPortMappings is empty array", async () => {
		const archive = await createFakeCheckpoint([]);

		const result = await rewriteCheckpointPorts(archive);

		expect(result.containerPorts).toEqual([]);
		expect(result.archive).toBe(archive);
	});

	test("preserves other config.dump fields", async () => {
		const archive = await createFakeCheckpoint([
			{ container_port: 8080, host_port: 32863, protocol: "tcp" },
		]);

		const result = await rewriteCheckpointPorts(archive);

		const config = await extractConfigDump(result.archive);
		expect(config.rootfsImageName).toBe("docker.io/library/python:3-alpine");
	});
});
