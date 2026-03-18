import { join } from "node:path";
import type { PodmanClient } from "@boilerhouse/runtime-podman";

/**
 * Attempts to read the CRIU dump.log for a container, which contains
 * detailed diagnostics when a checkpoint operation fails.
 *
 * Returns the log contents, or undefined if the log can't be read.
 */
export async function readCriuDumpLog(
	client: PodmanClient,
	podmanId: string,
): Promise<string | undefined> {
	try {
		const inspect = await client.inspectContainer(podmanId);
		const workPath = `/var/lib/containers/storage/overlay-containers/${inspect.Id}/userdata`;
		const dumpLogPath = join(workPath, "dump.log");
		const logFile = Bun.file(dumpLogPath);
		if (await logFile.exists()) {
			return await logFile.text();
		}
	} catch {
		// Best-effort — inspect may also fail if container is gone
	}
	return undefined;
}

/**
 * Wraps a checkpoint error with CRIU dump.log contents appended, if available.
 */
export async function enrichCheckpointError(
	err: unknown,
	client: PodmanClient,
	podmanId: string,
): Promise<never> {
	const criuLog = await readCriuDumpLog(client, podmanId);
	if (criuLog) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`${msg}\n\n── CRIU dump.log ──\n${criuLog}`);
	}
	throw err;
}
