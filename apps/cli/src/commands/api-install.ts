import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { apiServiceUnit } from "../embedded/api.service";

const UNIT_PATH = "/etc/systemd/system/boilerhouse-api.service";

export function apiInstallCommand(opts: { binaryPath?: string; dataDir?: string }): void {
	if (process.getuid?.() !== 0) {
		console.error("This command must be run as root.");
		process.exit(1);
	}

	const binaryPath = opts.binaryPath ?? process.execPath;
	const dataDir = opts.dataDir ?? "/var/lib/boilerhouse";

	const unit = apiServiceUnit(binaryPath, dataDir);
	writeFileSync(UNIT_PATH, unit, { mode: 0o644 });
	console.log(`Wrote ${UNIT_PATH}`);

	execSync("systemctl daemon-reload", { stdio: "inherit" });
	execSync("systemctl enable --now boilerhouse-api", { stdio: "inherit" });
	console.log("boilerhouse-api service enabled and started.");
}
