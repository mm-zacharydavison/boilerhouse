import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { getTestClient, uniqueName, CrdTracker, kubectlExec, CONTEXT, NAMESPACE, type KubeTestClient } from "./helpers";
import { openclawWorkload, claim } from "./fixtures";

describe("secret-gateway", () => {
	let client: KubeTestClient;
	const tracker = new CrdTracker();
	const secretName = "openclaw-creds";
	let secretCreated = false;

	beforeAll(() => {
		client = getTestClient();
	});

	afterAll(async () => {
		await tracker.cleanup(client);
		if (secretCreated) {
			Bun.spawnSync([
				"kubectl", "--context", CONTEXT, "-n", NAMESPACE,
				"delete", "secret", secretName, "--ignore-not-found",
			]);
		}
	});

	test("create secret, workload with credentials, claim, verify pod starts, verify secret not in env", async () => {
		// Create K8s Secret (idempotent via dry-run + apply)
		const dryRun = Bun.spawnSync([
			"kubectl", "--context", CONTEXT, "-n", NAMESPACE,
			"create", "secret", "generic", secretName,
			"--from-literal=token=sk-ant-e2e-test-key",
			"--dry-run=client", "-o", "yaml",
		]);
		const result = Bun.spawnSync([
			"kubectl", "--context", CONTEXT, "-n", NAMESPACE,
			"apply", "-f", "-",
		], { stdin: dryRun.stdout });
		expect(result.exitCode).toBe(0);
		secretCreated = true;

		// Create workload that references the secret
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(openclawWorkload(wlName));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		// Claim it
		const claimName = uniqueName("claim");
		tracker.track("boilerhouseclaims", claimName);
		await client.applyClaim(claim(claimName, "tenant-secret", wlName));
		const status = await client.waitForPhase("boilerhouseclaims", claimName, "Active");

		const instanceId = status.instanceId as string;
		expect(instanceId).toBeDefined();

		// Verify secret is NOT exposed in env vars
		const envResult = await kubectlExec(instanceId, ["printenv"]);
		expect(envResult.exitCode).toBe(0);
		expect(envResult.stdout).not.toContain("sk-ant-e2e-test-key");
	}, 120_000);
});
