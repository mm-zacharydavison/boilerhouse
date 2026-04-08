import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { getTestClient, uniqueName, CrdTracker, type KubeTestClient } from "./helpers";
import { httpserverWorkload, claim } from "./fixtures";

describe("concurrent-tenants", () => {
	let client: KubeTestClient;
	const tracker = new CrdTracker();

	beforeAll(() => {
		client = getTestClient();
	});

	afterAll(async () => {
		await tracker.cleanup(client);
	});

	test("3 claims for same workload simultaneously, all reach Active with distinct instanceIds", async () => {
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(httpserverWorkload(wlName));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		// Create 3 claims simultaneously
		const claimNames = [uniqueName("claim"), uniqueName("claim"), uniqueName("claim")];
		const tenantIds = ["tenant-conc-1", "tenant-conc-2", "tenant-conc-3"];

		for (let i = 0; i < 3; i++) {
			tracker.track("boilerhouseclaims", claimNames[i]);
		}

		await Promise.all(
			claimNames.map((name, i) => client.applyClaim(claim(name, tenantIds[i], wlName))),
		);

		// Wait for all to reach Active
		const statuses = await Promise.all(
			claimNames.map((name) => client.waitForPhase("boilerhouseclaims", name, "Active")),
		);

		// All should have distinct instanceIds
		const instanceIds = statuses.map((s) => s.instanceId as string);
		expect(instanceIds.every((id) => typeof id === "string" && id.length > 0)).toBe(true);

		const uniqueIds = new Set(instanceIds);
		expect(uniqueIds.size).toBe(3);
	}, 120_000);
});
