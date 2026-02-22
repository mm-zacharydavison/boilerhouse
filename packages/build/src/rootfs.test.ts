import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { createExt4, injectInit } from "./rootfs";
import type { InjectConfig } from "./types";

const INTEGRATION = process.env.BOILERHOUSE_INTEGRATION === "1";

describe.skipIf(!INTEGRATION)("rootfs", () => {
	let workDir: string;
	let tarPath: string;

	beforeAll(async () => {
		workDir = mkdtempSync(join(tmpdir(), "boilerhouse-rootfs-"));

		// Create a small tarball with some test files
		const contentDir = join(workDir, "content");
		const binDir = join(contentDir, "bin");
		const etcDir = join(contentDir, "etc");

		await Bun.spawn(["mkdir", "-p", binDir, etcDir], {
			stdout: "pipe",
			stderr: "pipe",
		}).exited;

		writeFileSync(join(binDir, "hello"), "#!/bin/sh\necho hello\n");
		writeFileSync(join(etcDir, "hostname"), "test-host\n");

		tarPath = join(workDir, "test-content.tar");
		const tarProc = Bun.spawn(
			["tar", "cf", tarPath, "-C", contentDir, "."],
			{ stdout: "pipe", stderr: "pipe" },
		);
		await tarProc.exited;
	});

	afterAll(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	test("creates an ext4 image of configured size from a tarball", async () => {
		const ext4Path = join(workDir, "test.ext4");
		await createExt4(tarPath, ext4Path, 1);

		expect(existsSync(ext4Path)).toBe(true);

		// Verify it's a valid ext4 image
		const proc = Bun.spawn(["file", ext4Path], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;

		expect(stdout).toContain("ext4");
	}, 30_000);

	test("ext4 image is mountable and contains the tarball contents", async () => {
		const ext4Path = join(workDir, "mountable.ext4");
		await createExt4(tarPath, ext4Path, 1);

		// Mount and verify contents
		const mountPoint = mkdtempSync(join(tmpdir(), "boilerhouse-mount-"));
		const loopProc = Bun.spawn(
			["sudo", "losetup", "--find", "--show", ext4Path],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const loopDevice = (await new Response(loopProc.stdout).text()).trim();
		await loopProc.exited;

		try {
			await Bun.spawn(
				["sudo", "mount", loopDevice, mountPoint],
				{ stdout: "pipe", stderr: "pipe" },
			).exited;

			expect(existsSync(join(mountPoint, "bin", "hello"))).toBe(true);
			expect(existsSync(join(mountPoint, "etc", "hostname"))).toBe(true);
		} finally {
			await Bun.spawn(
				["sudo", "umount", mountPoint],
				{ stdout: "pipe", stderr: "pipe" },
			).exited;
			await Bun.spawn(
				["sudo", "losetup", "-d", loopDevice],
				{ stdout: "pipe", stderr: "pipe" },
			).exited;
			rmSync(mountPoint, { recursive: true, force: true });
		}
	}, 30_000);

	test("init binary is injected at the correct path", async () => {
		const ext4Path = join(workDir, "inject-init.ext4");
		await createExt4(tarPath, ext4Path, 1);

		// Create dummy binaries
		const initBin = join(workDir, "init");
		const idleAgent = join(workDir, "idle-agent");
		const overlayInit = join(workDir, "overlay-init.sh");
		const healthAgent = join(workDir, "health-agent");
		writeFileSync(initBin, "#!/bin/sh\n# init binary\n");
		writeFileSync(idleAgent, "#!/bin/sh\n# idle agent\n");
		writeFileSync(overlayInit, "#!/bin/sh\n# overlay init\n");
		writeFileSync(healthAgent, "#!/bin/sh\n# health agent\n");

		const config: InjectConfig = {
			initBinaryPath: initBin,
			idleAgentPath: idleAgent,
			overlayInitPath: overlayInit,
			healthAgentPath: healthAgent,
		};

		await injectInit(ext4Path, config);

		// Verify by mounting and checking paths
		const mountPoint = mkdtempSync(join(tmpdir(), "boilerhouse-verify-"));
		const loopProc = Bun.spawn(
			["sudo", "losetup", "--find", "--show", ext4Path],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const loopDevice = (await new Response(loopProc.stdout).text()).trim();
		await loopProc.exited;

		try {
			await Bun.spawn(
				["sudo", "mount", loopDevice, mountPoint],
				{ stdout: "pipe", stderr: "pipe" },
			).exited;

			expect(existsSync(join(mountPoint, "opt", "boilerhouse", "init"))).toBe(true);
			expect(existsSync(join(mountPoint, "opt", "boilerhouse", "idle-agent"))).toBe(true);
			expect(existsSync(join(mountPoint, "opt", "boilerhouse", "overlay-init.sh"))).toBe(true);
			expect(existsSync(join(mountPoint, "opt", "boilerhouse", "health-agent"))).toBe(true);
		} finally {
			await Bun.spawn(
				["sudo", "umount", mountPoint],
				{ stdout: "pipe", stderr: "pipe" },
			).exited;
			await Bun.spawn(
				["sudo", "losetup", "-d", loopDevice],
				{ stdout: "pipe", stderr: "pipe" },
			).exited;
			rmSync(mountPoint, { recursive: true, force: true });
		}
	}, 30_000);
});
