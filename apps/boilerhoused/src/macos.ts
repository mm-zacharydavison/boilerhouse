import { existsSync } from "node:fs";

/**
 * macOS: ensure a podman machine is running.
 *
 * The podman machine exposes a local Unix socket automatically — we find it
 * via `podman machine inspect`. No subprocess to manage, so returns undefined.
 */
export async function ensurePodmanMachine(): Promise<void> {
	// Check if any machine exists
	const listProc = Bun.spawnSync(["podman", "machine", "list", "--format", "{{.Name}}"], {
		stdout: "pipe", stderr: "pipe",
	});
	const machines = new TextDecoder().decode(listProc.stdout).trim();

	if (!machines) {
		console.log("No podman machine found — initializing one...");
		const initProc = Bun.spawnSync(["podman", "machine", "init"], {
			stdout: "inherit", stderr: "inherit",
		});
		if (initProc.exitCode !== 0) {
			throw new Error("Failed to initialize podman machine");
		}
	}

	// Check if the machine is running
	const infoProc = Bun.spawnSync(["podman", "machine", "info", "--format", "{{.Host.MachineState}}"], {
		stdout: "pipe", stderr: "pipe",
	});
	const state = new TextDecoder().decode(infoProc.stdout).trim().toLowerCase();

	if (state !== "running") {
		console.log("Starting podman machine...");
		const startProc = Bun.spawnSync(["podman", "machine", "start"], {
			stdout: "inherit", stderr: "inherit",
		});
		if (startProc.exitCode !== 0) {
			throw new Error("Failed to start podman machine");
		}
	}

	// Verify connectivity
	const pingProc = Bun.spawnSync(["podman", "info", "--format", "{{.Host.RemoteSocket.Exists}}"], {
		stdout: "pipe", stderr: "pipe",
	});
	const pingOk = new TextDecoder().decode(pingProc.stdout).trim();
	if (pingOk !== "true") {
		throw new Error("podman machine is running but API socket is not reachable");
	}

	// CRIU checkpoint/restore requires rootful podman — check and give
	// actionable instructions if the machine is running rootless.
	const rootlessProc = Bun.spawnSync(
		["podman", "info", "--format", "{{.Host.Security.Rootless}}"],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const isRootless = new TextDecoder().decode(rootlessProc.stdout).trim() === "true";
	if (isRootless) {
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
