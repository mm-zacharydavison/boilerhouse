import { dirname } from "node:path";
import { OciError } from "./errors";

/**
 * Pull an OCI image using the Docker CLI.
 * @throws {OciError} if the pull fails
 */
export async function pullImage(ref: string): Promise<void> {
	await runDocker(["pull", ref]);
}

/**
 * Export an OCI image's filesystem to a tarball.
 *
 * Creates a temporary container, exports its filesystem, then removes the container.
 *
 * @throws {OciError} if any Docker command fails
 */
export async function exportFilesystem(ref: string, outputTar: string): Promise<void> {
	// Create a temporary container (without starting it)
	const createProc = Bun.spawn(["docker", "create", ref], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const containerId = (await new Response(createProc.stdout).text()).trim();
	const createExit = await createProc.exited;

	if (createExit !== 0) {
		const stderr = await new Response(createProc.stderr).text();
		throw new OciError(
			`Failed to create container from ${ref}: ${stderr.trim()}`,
			createExit,
		);
	}

	try {
		await runDocker(["export", containerId, "-o", outputTar]);
	} finally {
		// Clean up the temporary container
		const rmProc = Bun.spawn(["docker", "rm", containerId], {
			stdout: "pipe",
			stderr: "pipe",
		});
		await rmProc.exited;
	}
}

/**
 * Build a Docker image from a Dockerfile and export its filesystem to a tarball.
 *
 * @param dockerfile - Absolute path to the Dockerfile
 * @param outputTar - Path where the exported tarball will be written
 * @throws {OciError} if the build or export fails
 */
export async function buildImage(dockerfile: string, outputTar: string): Promise<void> {
	const context = dirname(dockerfile);
	const tempTag = `boilerhouse-build-${Date.now()}`;

	try {
		await runDocker(["build", "-t", tempTag, "-f", dockerfile, context]);
		await exportFilesystem(tempTag, outputTar);
	} finally {
		// Clean up the temporary image
		const rmiProc = Bun.spawn(["docker", "rmi", tempTag], {
			stdout: "pipe",
			stderr: "pipe",
		});
		await rmiProc.exited;
	}
}

async function runDocker(args: string[]): Promise<void> {
	const proc = Bun.spawn(["docker", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;

	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new OciError(
			`docker ${args[0]} failed: ${stderr.trim()}`,
			exitCode,
		);
	}
}
