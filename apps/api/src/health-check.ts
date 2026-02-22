import { createServer } from "node:net";
import { unlinkSync } from "node:fs";
import type { Runtime, InstanceHandle } from "@boilerhouse/core";

export interface HealthConfig {
	/** Interval between health check polls in ms. */
	interval: number;
	/** Number of consecutive failures before aborting. */
	unhealthyThreshold: number;
	/** Overall timeout deadline in ms. */
	timeoutMs: number;
}

/** A probe-agnostic health check function. Returns `true` when healthy. */
export type HealthCheckFn = () => Promise<boolean>;

export class HealthCheckTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HealthCheckTimeoutError";
	}
}

/**
 * Polls a health check function until it returns `true`.
 *
 * Fails if:
 * - `unhealthyThreshold` consecutive `false`/throw results are received
 * - The overall `timeoutMs` deadline elapses
 */
export async function pollHealth(
	check: HealthCheckFn,
	config: HealthConfig,
	onLog?: (line: string) => void,
): Promise<void> {
	const deadline = Date.now() + config.timeoutMs;
	let consecutiveFailures = 0;
	let attempt = 0;

	while (Date.now() < deadline) {
		attempt++;
		try {
			const healthy = await check();
			if (healthy) {
				return;
			}
			consecutiveFailures++;
		} catch (err) {
			consecutiveFailures++;
			onLog?.(`Health check attempt ${attempt} threw: ${err instanceof Error ? err.message : String(err)}`);
		}

		onLog?.(`Health check attempt ${attempt} failed (${consecutiveFailures}/${config.unhealthyThreshold} consecutive failures)`);

		if (consecutiveFailures >= config.unhealthyThreshold) {
			throw new HealthCheckTimeoutError(
				`Health check failed after ${consecutiveFailures} consecutive failures`,
			);
		}

		await new Promise((resolve) => setTimeout(resolve, config.interval));
	}

	throw new HealthCheckTimeoutError(
		`Health check timed out after ${config.timeoutMs}ms`,
	);
}

/** Creates a health check that fetches an HTTP URL and expects status 200. */
export function createHttpCheck(url: string, onLog?: (line: string) => void): HealthCheckFn {
	return async () => {
		const res = await fetch(url, {
			signal: AbortSignal.timeout(5000),
		});
		if (res.status !== 200) {
			onLog?.(`HTTP health check: status=${res.status} (expected 200)`);
			return false;
		}
		return true;
	};
}

export interface VsockCheckHandle {
	/** Health check function that returns the latest health status. */
	check: HealthCheckFn;
	/** Cleans up the Unix socket server. */
	cleanup: () => void;
}

/**
 * Creates a health check that listens on a Unix socket for vsock-proxied
 * health reports from the guest agent.
 *
 * Firecracker proxies vsock connections from the guest to a Unix domain
 * socket at `<vsockUdsPath>_<port>`. The guest health-agent connects to
 * the host (CID 2) on the given port, which Firecracker maps to this socket.
 *
 * Protocol: the guest sends `HEALTH OK\n` or `HEALTH FAIL <code>\n`.
 */
export function createVsockCheck(
	vsockUdsPath: string,
	port: number,
	onLog?: (line: string) => void,
): VsockCheckHandle {
	const socketPath = `${vsockUdsPath}_${port}`;
	let healthy = false;

	const server = createServer((conn) => {
		let buffer = "";
		conn.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop()!;
			for (const line of lines) {
				if (line === "HEALTH OK") {
					healthy = true;
				} else if (line.startsWith("HEALTH FAIL")) {
					healthy = false;
					onLog?.(`Vsock health report: ${line}`);
				}
			}
		});
	});

	server.listen(socketPath);

	const check: HealthCheckFn = async () => healthy;

	const cleanup = () => {
		server.close();
		try {
			unlinkSync(socketPath);
		} catch {
			// Socket file may already be cleaned up
		}
	};

	return { check, cleanup };
}

/** Creates a health check that executes a command in the guest VM. Exit code 0 = healthy. */
export function createExecCheck(
	runtime: Runtime,
	handle: InstanceHandle,
	command: string[],
	onLog?: (line: string) => void,
): HealthCheckFn {
	return async () => {
		const result = await runtime.exec(handle, command);
		if (result.exitCode !== 0) {
			const stdout = result.stdout.slice(0, 200);
			const stderr = result.stderr.slice(0, 200);
			onLog?.(`Exec health check: exitCode=${result.exitCode} stdout="${stdout}" stderr="${stderr}"`);
			return false;
		}
		return true;
	};
}
