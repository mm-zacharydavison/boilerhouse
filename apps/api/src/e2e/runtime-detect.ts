import { existsSync } from "node:fs";

export interface RuntimeAvailability {
	/** Always available */
	fake: true;
	/** `docker info` succeeds */
	docker: boolean;
	/** Podman API socket exists and is connectable */
	podman: boolean;
}

function commandSucceeds(cmd: string, args: string[]): boolean {
	try {
		const result = Bun.spawnSync([cmd, ...args], {
			stdout: "ignore",
			stderr: "ignore",
		});
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

/**
 * Check that the podman API socket exists AND the daemon is responsive.
 * existsSync alone is not enough — stale socket files from crashed daemons
 * cause tests to hang instead of skipping.
 */
function podmanSocketAvailable(): boolean {
	const socketPath = process.env.PODMAN_SOCKET ?? "/run/boilerhouse/podman.sock";
	try {
		if (!existsSync(socketPath)) return false;
		const result = Bun.spawnSync(
			["curl", "--unix-socket", socketPath, "--max-time", "2", "-sf", "http://localhost/_ping"],
			{ stdout: "pipe", stderr: "ignore" },
		);
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

export function detectRuntimes(): RuntimeAvailability {
	const docker = commandSucceeds("docker", ["info"]);
	const podman = podmanSocketAvailable();

	return {
		fake: true,
		docker,
		podman,
	};
}
