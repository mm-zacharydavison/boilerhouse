import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { getTestClient, uniqueName, CrdTracker, kubectlPodExists, kubectlGetPodPhase, type KubeTestClient } from "./helpers";
import { httpserverWorkload, claim } from "./fixtures";

describe("instance-lifecycle", () => {
	let client: KubeTestClient;
	const tracker = new CrdTracker();

	beforeAll(() => {
		client = getTestClient();
	});

	afterAll(async () => {
		await tracker.cleanup(client);
	});

	test("create workload → claim → verify pod running → delete claim → verify pod cleaned up", async () => {
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(httpserverWorkload(wlName));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		const claimName = uniqueName("claim");
		tracker.track("boilerhouseclaims", claimName);
		await client.applyClaim(claim(claimName, "tenant-lifecycle-1", wlName));
		const status = await client.waitForPhase("boilerhouseclaims", claimName, "Active");

		expect(status.instanceId).toBeDefined();
		expect(typeof status.instanceId).toBe("string");
		const instanceId = status.instanceId as string;

		// Verify pod is running
		const podPhase = await kubectlGetPodPhase(instanceId);
		expect(podPhase).toBe("Running");

		// Delete claim
		await client.delete("boilerhouseclaims", claimName);
		await client.waitForDeletion("boilerhouseclaims", claimName);

		// Wait for pod cleanup
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			if (!(await kubectlPodExists(instanceId))) break;
			await new Promise((r) => setTimeout(r, 1_000));
		}
		expect(await kubectlPodExists(instanceId)).toBe(false);
	}, 120_000);
});
