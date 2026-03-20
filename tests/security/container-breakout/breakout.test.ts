import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import { availableRuntimes, E2E_TIMEOUTS } from "../../../apps/api/src/e2e/runtime-matrix";
import {
	startE2EServer,
	api,
	readFixture,
	waitForWorkloadReady,
	type E2EServer,
} from "../../../apps/api/src/e2e/e2e-helpers";
import { ensureCDK } from "./tools";

/**
 * Exec a command inside a container via the API.
 */
async function execIn(
	server: E2EServer,
	instanceId: string,
	command: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const res = await api(server, "POST", `/api/v1/instances/${instanceId}/exec`, { command });
	expect(res.status).toBe(200);
	return res.json() as Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/**
 * Upload a local binary into a container using `podman cp` or `kubectl cp`,
 * depending on the runtime. This bypasses the API — acceptable because the
 * breakout test assumes the container is already compromised.
 */
async function uploadBinary(
	runtime: string,
	instanceId: string,
	localPath: string,
	remotePath: string,
): Promise<void> {
	if (runtime === "kubernetes") {
		await kubectlCp(instanceId, localPath, remotePath);
	} else {
		await podmanCp(instanceId, localPath, remotePath);
	}
}

async function podmanCp(instanceId: string, localPath: string, remotePath: string): Promise<void> {
	await runOrThrow(["podman", "cp", localPath, `${instanceId}:${remotePath}`]);
	await runOrThrow(["podman", "exec", instanceId, "chmod", "+x", remotePath]);
}

async function kubectlCp(instanceId: string, localPath: string, remotePath: string): Promise<void> {
	const ctx = "boilerhouse-test";
	const ns = "boilerhouse";
	await runOrThrow([
		"kubectl", "--context", ctx, "-n", ns, "cp",
		localPath, `${instanceId}:${remotePath}`, "-c", "main",
	]);
	await runOrThrow([
		"kubectl", "--context", ctx, "-n", ns, "exec", instanceId,
		"-c", "main", "--", "chmod", "+x", remotePath,
	]);
}

async function runOrThrow(cmd: string[]): Promise<void> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`${cmd[0]} failed (exit ${exitCode}): ${stderr}`);
	}
}

/** Parse CDK evaluate output into findings (lines starting with [!]). */
function parseCDKFindings(output: string): string[] {
	return output
		.split("\n")
		.filter((line) => line.includes("[!]"))
		.map((line) => line.trim());
}

// Only run on real runtimes with exec + networking
const realRuntimes = availableRuntimes().filter(
	(rt) => rt.name !== "fake" && rt.capabilities.exec && rt.capabilities.networking,
);

if (realRuntimes.length === 0) {
	test.skip("no real runtimes available for container breakout tests", () => {});
}

for (const rt of realRuntimes) {
	const timeouts = E2E_TIMEOUTS[rt.name as keyof typeof E2E_TIMEOUTS] ?? E2E_TIMEOUTS.fake;

	describe(`[${rt.name}] CDK container breakout`, () => {
		setDefaultTimeout(timeouts.operation * 4);

		let server: E2EServer;
		let workloadName: string;
		let cdkPath: string;

		beforeAll(async () => {
			cdkPath = await ensureCDK();
			server = await startE2EServer(rt.name);

			const fixture = await readFixture(rt.workloadFixtures.openclaw);
			const registerRes = await api(server, "POST", "/api/v1/workloads", fixture);
			expect(registerRes.status).toBe(201);
			workloadName = ((await registerRes.json()) as { name: string }).name;

			await waitForWorkloadReady(server, workloadName, timeouts.operation);
		}, timeouts.operation * 2);

		afterAll(async () => {
			if (server) await server.cleanup();
		});

		test("CDK evaluate finds no critical escape vectors", async () => {
			const claimRes = await api(server, "POST", "/api/v1/tenants/sec-breakout-cdk/claim", {
				workload: workloadName,
			});
			expect(claimRes.status).toBe(200);
			const { instanceId } = (await claimRes.json()) as { instanceId: string };

			// Upload CDK binary — this test assumes the container is already
			// compromised, so bypassing the API is fine
			await uploadBinary(rt.name, instanceId, cdkPath, "/tmp/cdk");

			// Run CDK evaluate
			const result = await execIn(server, instanceId, [
				"sh", "-c", "/tmp/cdk evaluate 2>&1",
			]);

			const output = result.stdout + "\n" + result.stderr;
			const findings = parseCDKFindings(output);

			console.log("=== CDK Evaluate Output ===");
			console.log(output);
			if (findings.length > 0) {
				console.log("\n=== CDK Findings ===");
				for (const f of findings) console.log(f);
			}

			// Critical escape vectors that must not be present
			const critical = [
				"privileged mode",
				"docker.sock",
				"podman.sock",
				"/var/run/docker",
				"mount host",
				"SYS_ADMIN",
				"SYS_PTRACE",
				"DAC_READ_SEARCH",
			];

			const criticalFindings = findings.filter((f) =>
				critical.some((c) => f.toLowerCase().includes(c.toLowerCase())),
			);

			expect(criticalFindings).toEqual([]);
		});
	});
}
