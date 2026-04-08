import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { getTestClient, uniqueName, CrdTracker, kubectlExec, kubectlLogs, kubectlPodExists, type KubeTestClient } from "./helpers";
import { httpserverWorkload, claim } from "./fixtures";

describe("instance-actions", () => {
	let client: KubeTestClient;
	const tracker = new CrdTracker();

	beforeAll(() => {
		client = getTestClient();
	});

	afterAll(async () => {
		await tracker.cleanup(client);
	});

	test("kubectlExec and kubectlLogs on managed pod; pod destroyed after claim deletion", async () => {
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(httpserverWorkload(wlName));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		const claimName = uniqueName("claim");
		tracker.track("boilerhouseclaims", claimName);
		await client.applyClaim(claim(claimName, "tenant-actions", wlName));
		const status = await client.waitForPhase("boilerhouseclaims", claimName, "Active");

		const instanceId = status.instanceId as string;
		expect(instanceId).toBeDefined();

		// Exec into the pod
		const execResult = await kubectlExec(instanceId, ["echo", "hello-from-exec"]);
		expect(execResult.exitCode).toBe(0);
		expect(execResult.stdout.trim()).toBe("hello-from-exec");

		// Get logs
		const logs = await kubectlLogs(instanceId, 10);
		expect(typeof logs).toBe("string");

		// Delete claim and verify pod cleanup
		await client.delete("boilerhouseclaims", claimName);
		await client.waitForDeletion("boilerhouseclaims", claimName);

		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			if (!(await kubectlPodExists(instanceId))) break;
			await new Promise((r) => setTimeout(r, 1_000));
		}
		expect(await kubectlPodExists(instanceId)).toBe(false);
	}, 120_000);
});
