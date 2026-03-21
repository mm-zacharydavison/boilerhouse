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
	.description("Set up the VM: install podman/CRIU, create user, generate secrets, start podmand")
	.option("--skip-firewall", "Skip nftables firewall configuration")
	.option("--binary-path <path>", "Path to the boilerhouse binary (default: current executable)")
	.option("--data-dir <path>", "Data directory (default: /var/lib/boilerhouse)")
	.action(async (opts: { skipFirewall?: boolean; binaryPath?: string; dataDir?: string }) => {
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
	.description("Remove systemd services (data preserved)")
	.action(() => {
		hostUninstallCommand();
	});

// ── api ───────────────────────────────────────────────────────────────────────

const api = program.command("api").description("API server management");

api
	.command("start")
	.description("Run the API server (foreground)")
	.action(async () => {
		const { apiStartCommand } = await import("./commands/api-start");
		await apiStartCommand();
	});

api
	.command("install")
	.description("Install the API as a systemd service")
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
