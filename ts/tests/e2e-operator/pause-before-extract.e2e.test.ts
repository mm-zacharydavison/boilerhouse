import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { getTestClient, uniqueName, CrdTracker, kubectlExec, operatorApiUrl, type KubeTestClient } from "./helpers";
import { overlayWorkload, claim } from "./fixtures";

describe("pause-before-extract", () => {
	let client: KubeTestClient;
	const tracker = new CrdTracker();

	beforeAll(() => {
		client = getTestClient();
	});

	afterAll(async () => {
		await tracker.cleanup(client);
	});

	test("create overlay workload + claim, write data, POST extract to operator API, verify 200", async () => {
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(overlayWorkload(wlName));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		const claimName = uniqueName("claim");
		tracker.track("boilerhouseclaims", claimName);
		await client.applyClaim(claim(claimName, "tenant-extract", wlName));
		const status = await client.waitForPhase("boilerhouseclaims", claimName, "Active");

		const instanceId = status.instanceId as string;
		expect(instanceId).toBeDefined();

		// Write some data first
		const writeResult = await kubectlExec(instanceId, [
			"sh", "-c", "echo 'extract-test-data' > /data/extract-file.txt",
		]);
		expect(writeResult.exitCode).toBe(0);

		// POST extract request to operator internal API
		const res = await fetch(`${operatorApiUrl}/api/v1/instances/${instanceId}/overlay/extract`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
		});

		expect(res.status).toBe(200);
	}, 120_000);
});
