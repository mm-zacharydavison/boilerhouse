import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmdirSync } from "node:fs";
import { RootfsError } from "./errors";
import type { InjectConfig } from "./types";

interface MountedImage {
	loopDevice: string;
	mountPoint: string;
}

/**
 * Create an ext4 filesystem image from a tarball.
 *
 * 1. Creates a sparse file of the given size
 * 2. Formats it as ext4
 * 3. Loop-mounts it
 * 4. Extracts the tarball contents into it
 *
 * Requires `sudo` for loop mount operations.
 *
 * @throws {RootfsError} if any step fails
 */
export async function createExt4(
	tarPath: string,
	outputPath: string,
	sizeGb: number,
	onLog?: (line: string) => void,
): Promise<void> {
	// Create sparse file
	await run(
		["dd", "if=/dev/zero", `of=${outputPath}`, "bs=1", "count=0", `seek=${sizeGb}G`],
		"Failed to create sparse file",
		onLog,
	);

	// Format as ext4
	await run(
		["mkfs.ext4", "-F", outputPath],
		"Failed to format ext4",
		onLog,
	);

	// Mount, extract tarball, unmount
	const mounted = await mountImage(outputPath);
	try {
		await run(
			["sudo", "tar", "xf", tarPath, "-C", mounted.mountPoint],
			"Failed to extract tarball into ext4",
			onLog,
		);
	} finally {
		await unmountImage(mounted);
	}
}

/**
 * Inject boilerhouse init binaries into an ext4 filesystem image.
 *
 * Mounts the image, creates `/opt/boilerhouse/`, copies each binary, and sets permissions.
 *
 * @throws {RootfsError} if mount or copy operations fail
 */
export async function injectInit(
	ext4Path: string,
	config: InjectConfig,
	onLog?: (line: string) => void,
): Promise<void> {
	const mounted = await mountImage(ext4Path);
	try {
		const dest = join(mounted.mountPoint, "opt", "boilerhouse");
		await run(
			["sudo", "mkdir", "-p", dest],
			"Failed to create /opt/boilerhouse",
			onLog,
		);

		const files: Array<{ src: string; name: string }> = [
			{ src: config.initBinaryPath, name: "init" },
			{ src: config.idleAgentPath, name: "idle-agent" },
			{ src: config.overlayInitPath, name: "overlay-init.sh" },
		];

		for (const { src, name } of files) {
			const target = join(dest, name);
			await run(
				["sudo", "cp", src, target],
				`Failed to copy ${name}`,
				onLog,
			);
			await run(
				["sudo", "chmod", "755", target],
				`Failed to chmod ${name}`,
				onLog,
			);
		}
	} finally {
		await unmountImage(mounted);
	}
}

async function mountImage(ext4Path: string): Promise<MountedImage> {
	const loopProc = Bun.spawn(
		["sudo", "losetup", "--find", "--show", ext4Path],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const loopDevice = (await new Response(loopProc.stdout).text()).trim();
	const loopExit = await loopProc.exited;

	if (loopExit !== 0) {
		const stderr = await new Response(loopProc.stderr).text();
		throw new RootfsError(`Failed to set up loop device: ${stderr.trim()}`);
	}

	const mountPoint = mkdtempSync(join(tmpdir(), "boilerhouse-rootfs-"));

	const mountProc = Bun.spawn(
		["sudo", "mount", loopDevice, mountPoint],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const mountExit = await mountProc.exited;

	if (mountExit !== 0) {
		const stderr = await new Response(mountProc.stderr).text();
		// Clean up loop device if mount fails
		await Bun.spawn(["sudo", "losetup", "-d", loopDevice], {
			stdout: "pipe",
			stderr: "pipe",
		}).exited;
		throw new RootfsError(`Failed to mount: ${stderr.trim()}`);
	}

	return { loopDevice, mountPoint };
}

async function unmountImage(mounted: MountedImage): Promise<void> {
	const umountProc = Bun.spawn(
		["sudo", "umount", mounted.mountPoint],
		{ stdout: "pipe", stderr: "pipe" },
	);
	await umountProc.exited;

	const loopProc = Bun.spawn(
		["sudo", "losetup", "-d", mounted.loopDevice],
		{ stdout: "pipe", stderr: "pipe" },
	);
	await loopProc.exited;

	try {
		rmdirSync(mounted.mountPoint);
	} catch {
		// Best-effort cleanup
	}
}

async function run(args: string[], errorPrefix: string, onLog?: (line: string) => void): Promise<void> {
	const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });

	if (onLog && proc.stdout) {
		const reader = proc.stdout.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop()!;
				for (const line of lines) {
					if (line.length > 0) onLog(line);
				}
			}
			if (buffer.length > 0) onLog(buffer);
		} finally {
			reader.releaseLock();
		}
	}

	const exitCode = await proc.exited;

	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new RootfsError(`${errorPrefix}: ${stderr.trim()}`);
	}
}
