import { Command } from "commander";
import { checkForUpdatesInBackground } from "./update-check";
import { versionCommand } from "./commands/version";
import {
	hostInstallCommand,
	hostStatusCommand,
	hostUninstallCommand,
} from "./commands/host-install";
import { apiInstallCommand } from "./commands/api-install";

declare const BOILERHOUSE_VERSION: string;

function getVersion(): string {
	return typeof BOILERHOUSE_VERSION !== "undefined" ? BOILERHOUSE_VERSION : "dev";
}

const program = new Command();

program
	.name("boilerhouse")
	.description("Boilerhouse — container runtime manager")
	.version(getVersion(), "-V, --version");

// ── host ──────────────────────────────────────────────────────────────────────

const host = program.command("host").description("Host VM management");

host
	.command("install")
	.description("Install runtime dependencies on the host")
	.option("--podman", "Install Podman runtime: podman, CRIU, podmand systemd service")
	.option("--skip-firewall", "Skip nftables firewall configuration")
	.option("--binary-path <path>", "Path to the boilerhouse binary (default: current executable)")
	.option("--data-dir <path>", "Data directory (default: /var/lib/boilerhouse)")
	.action(async (opts: { podman?: boolean; skipFirewall?: boolean; binaryPath?: string; dataDir?: string }) => {
		if (!opts.podman) {
			console.error("Specify a runtime to install. Currently supported: --podman");
			console.error("");
			console.error("Example: boilerhouse host install --podman");
			process.exit(1);
		}
		await hostInstallCommand({
			skipFirewall: opts.skipFirewall,
			binaryPath: opts.binaryPath,
			dataDir: opts.dataDir,
		});
		checkForUpdatesInBackground(getVersion());
	});

host
	.command("status")
	.description("Check host health (podmand, socket, CRIU, disk)")
	.action(() => {
		hostStatusCommand();
		checkForUpdatesInBackground(getVersion());
	});

host
	.command("uninstall")
	.description("Remove runtime services from the host (data preserved)")
	.option("--podman", "Uninstall Podman runtime: podmand service, firewall rules")
	.action((opts: { podman?: boolean }) => {
		if (!opts.podman) {
			console.error("Specify a runtime to uninstall. Currently supported: --podman");
			console.error("");
			console.error("Example: boilerhouse host uninstall --podman");
			process.exit(1);
		}
		hostUninstallCommand();
	});

// ── api ───────────────────────────────────────────────────────────────────────

const api = program.command("api").description("API server (use docker-compose for production)");

api
	.command("start")
	.description("Run the API server on the host (foreground, for dev/testing)")
	.action(async () => {
		const { apiStartCommand } = await import("./commands/api-start");
		await apiStartCommand();
	});

api
	.command("install")
	.description("Install the API as a systemd service on the host (alternative to Docker)")
	.option("--binary-path <path>", "Path to the boilerhouse binary (default: current executable)")
	.option("--data-dir <path>", "Data directory (default: /var/lib/boilerhouse)")
	.action((opts: { binaryPath?: string; dataDir?: string }) => {
		apiInstallCommand({ binaryPath: opts.binaryPath, dataDir: opts.dataDir });
		checkForUpdatesInBackground(getVersion());
	});

// ── podmand ───────────────────────────────────────────────────────────────────

const podmand = program.command("podmand").description("Podman runtime daemon management");

podmand
	.command("start")
	.description("Run podmand (foreground)")
	.action(async () => {
		const { podmandStartCommand } = await import("./commands/podmand-start");
		await podmandStartCommand();
	});

// ── update / version ──────────────────────────────────────────────────────────

program
	.command("update")
	.description("Download and install the latest version")
	.action(async () => {
		const { updateCommand } = await import("./commands/update");
		await updateCommand();
	});

program
	.command("version")
	.description("Print version + commit")
	.action(() => {
		versionCommand();
	});

program.parse(process.argv);
