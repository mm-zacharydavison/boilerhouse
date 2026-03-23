import { existsSync } from "node:fs";

/** Run a command and return { exitCode, stdout }. */
async function run(
	cmd: string[],
	opts?: { inherit?: boolean },
): Promise<{ exitCode: number; stdout: string }> {
	const proc = Bun.spawn(cmd, {
		stdout: opts?.inherit ? "inherit" : "pipe",
		stderr: opts?.inherit ? "inherit" : "pipe",
	});
	const stdout = opts?.inherit
		? ""
		: await new Response(proc.stdout).text();
	const exitCode = await proc.exited;
	return { exitCode, stdout: stdout.trim() };
}

/**
 * macOS: ensure a podman machine is running.
 *
 * The podman machine exposes a local Unix socket automatically — we find it
 * via `podman machine inspect`. No subprocess to manage, so returns undefined.
 */
export async function ensurePodmanMachine(): Promise<void> {
	// Check if any machine exists
	const { stdout: machines } = await run([
		"podman", "machine", "list", "--format", "{{.Name}}",
	]);

	if (!machines) {
		console.log("No podman machine found — initializing one (rootful)...");
		const { exitCode } = await run(
			["podman", "machine", "init", "--rootful"],
			{ inherit: true },
		);
		if (exitCode !== 0) {
			throw new Error("Failed to initialize podman machine");
		}
	}

	// Check if the machine is running
	const { stdout: state } = await run([
		"podman", "machine", "info", "--format", "{{.Host.MachineState}}",
	]);

	if (state.toLowerCase() !== "running") {
		console.log("Starting podman machine...");
		const { exitCode } = await run(
			["podman", "machine", "start"],
			{ inherit: true },
		);
		if (exitCode !== 0) {
			throw new Error("Failed to start podman machine");
		}
	}

	// Verify connectivity — if the machine is "running" but the socket is
	// unreachable (stale SSH tunnel), restart the machine once before failing.
	const { stdout: pingOk } = await run([
		"podman", "info", "--format", "{{.Host.RemoteSocket.Exists}}",
	]);
	if (pingOk !== "true") {
		console.log("podman machine is running but API socket is stale — restarting machine...");
		await run(["podman", "machine", "stop"], { inherit: true });
		const { exitCode } = await run(["podman", "machine", "start"], { inherit: true });
		if (exitCode !== 0) {
			throw new Error("Failed to restart podman machine");
		}
		const { stdout: retryPing } = await run([
			"podman", "info", "--format", "{{.Host.RemoteSocket.Exists}}",
		]);
		if (retryPing !== "true") {
			throw new Error("podman machine is running but API socket is not reachable (even after restart)");
		}
	}

	// Warn if the machine has low memory — the observability stack
	// (Grafana + Tempo + Prometheus) plus workload containers need ~4GB+.
	const MIN_MEMORY_MB = 4096;
	const { stdout: memoryStr } = await run([
		"podman", "machine", "inspect", "--format", "{{.Resources.Memory}}",
	]);
	const memoryMB = parseInt(memoryStr, 10);
	if (memoryMB && memoryMB < MIN_MEMORY_MB) {
		console.warn(
			`⚠ Podman machine has ${memoryMB}MB memory — this may cause crashes when running the observability stack.\n` +
			`  To increase, run:\n` +
			`    podman machine stop\n` +
			`    podman machine set --memory ${MIN_MEMORY_MB}\n` +
			`    podman machine start`,
		);
	}

	// CRIU checkpoint/restore requires rootful podman — check and give
	// actionable instructions if the machine is running rootless.
	const { stdout: rootless } = await run([
		"podman", "info", "--format", "{{.Host.Security.Rootless}}",
	]);
	if (rootless === "true") {
		throw new Error(
			[
				"Podman machine is running in rootless mode. Boilerhouse requires rootful mode for CRIU checkpoint/restore.",
				"",
				"To fix, run:",
				"  podman machine stop",
				"  podman machine set --rootful",
				"  podman machine start",
			].join("\n"),
		);
	}
}

/**
 * Discover the podman machine's local API socket path via
 * `podman machine inspect`. This is a host-side socket that the machine
 * creates automatically (typically under /var/folders/...).
 */
export function detectPodmanSocket(): string {
	const proc = Bun.spawnSync(
		["podman", "machine", "inspect", "--format", "{{.ConnectionInfo.PodmanSocket.Path}}"],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const socketPath = new TextDecoder().decode(proc.stdout).trim();
	if (!socketPath || !existsSync(socketPath)) {
		throw new Error(
			`Could not detect podman machine API socket (got: ${socketPath || "<empty>"})`,
		);
	}
	return socketPath;
}
