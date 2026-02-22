import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	mkdtempSync,
	rmSync,
	existsSync,
	writeFileSync,
	readFileSync,
} from "node:fs";
import { build } from "./builder";
import type { InjectConfig, Manifest } from "./types";

const INTEGRATION = process.env.BOILERHOUSE_INTEGRATION === "1";

const WORKLOAD_TOML = `
[workload]
name = "test-app"
version = "1.0.0"

[image]
ref = "alpine:latest"

[resources]
vcpus = 1
memory_mb = 512
disk_gb = 1

[network]
access = "none"

[idle]
action = "hibernate"
`;

describe.skipIf(!INTEGRATION)("builder", () => {
	let workDir: string;
	let outputDir: string;
	let workloadPath: string;
	let injectConfig: InjectConfig;

	beforeAll(() => {
		workDir = mkdtempSync(join(tmpdir(), "boilerhouse-builder-"));
		outputDir = join(workDir, "artifacts");

		workloadPath = join(workDir, "workload.toml");
		writeFileSync(workloadPath, WORKLOAD_TOML);

		// Create dummy init binaries
		const initBin = join(workDir, "init");
		const idleAgent = join(workDir, "idle-agent");
		const overlayInit = join(workDir, "overlay-init.sh");
		const healthAgent = join(workDir, "health-agent");
		writeFileSync(initBin, "#!/bin/sh\n# init\n");
		writeFileSync(idleAgent, "#!/bin/sh\n# idle-agent\n");
		writeFileSync(overlayInit, "#!/bin/sh\n# overlay-init\n");
		writeFileSync(healthAgent, "#!/bin/sh\n# health-agent\n");

		injectConfig = {
			initBinaryPath: initBin,
			idleAgentPath: idleAgent,
			overlayInitPath: overlayInit,
			healthAgentPath: healthAgent,
		};
	});

	afterAll(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	test("end-to-end: workload TOML → ext4 rootfs with init injected", async () => {
		const ref = await build(workloadPath, outputDir, injectConfig);

		expect(ref.hash).toMatch(/^[a-f0-9]{64}$/);
		expect(existsSync(ref.rootfsPath)).toBe(true);
		expect(existsSync(ref.manifestPath)).toBe(true);
	}, 120_000);

	test("output directory structure matches spec", async () => {
		const ref = await build(workloadPath, outputDir, injectConfig);

		expect(ref.rootfsPath).toBe(join(outputDir, ref.hash, "rootfs.ext4"));
		expect(ref.manifestPath).toBe(join(outputDir, ref.hash, "manifest.json"));
	}, 120_000);

	test("manifest.json is valid", async () => {
		const ref = await build(workloadPath, outputDir, injectConfig);

		const raw = readFileSync(ref.manifestPath, "utf-8");
		const manifest: Manifest = JSON.parse(raw);

		expect(manifest.imageSource).toBe("alpine:latest");
		expect(manifest.workloadName).toBe("test-app");
		expect(manifest.workloadVersion).toBe("1.0.0");
		expect(manifest.diskGb).toBe(1);
		expect(manifest.hash).toMatch(/^[a-f0-9]{64}$/);
		expect(manifest.sizeBytes).toBeGreaterThan(0);
		// Verify buildDate is valid ISO 8601
		expect(() => new Date(manifest.buildDate)).not.toThrow();
		expect(new Date(manifest.buildDate).toISOString()).toBe(manifest.buildDate);
	}, 120_000);
});
