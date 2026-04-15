import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { getTestClient, uniqueName, CrdTracker, type KubeTestClient } from "./helpers";
import { httpserverWorkload, minimalWorkload, claim } from "./fixtures";

describe("multi-workload-claim", () => {
	let client: KubeTestClient;
	const tracker = new CrdTracker();

	beforeAll(() => {
		client = getTestClient();
	});

	afterAll(async () => {
		await tracker.cleanup(client);
	});

	test("same tenant claims two different workloads, delete one claim, other remains Active", async () => {
		const wlName1 = uniqueName("wl");
		const wlName2 = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName1);
		tracker.track("boilerhouseworkloads", wlName2);

		await Promise.all([
			client.applyWorkload(httpserverWorkload(wlName1)),
			client.applyWorkload(minimalWorkload(wlName2)),
		]);

		await Promise.all([
			client.waitForPhase("boilerhouseworkloads", wlName1, "Ready"),
			client.waitForPhase("boilerhouseworkloads", wlName2, "Ready"),
		]);

		const tenantId = "tenant-multi-wl";
		const claimName1 = uniqueName("claim");
		const claimName2 = uniqueName("claim");
		tracker.track("boilerhouseclaims", claimName1);
		tracker.track("boilerhouseclaims", claimName2);

		await client.applyClaim(claim(claimName1, tenantId, wlName1));
		await client.applyClaim(claim(claimName2, tenantId, wlName2));

		await Promise.all([
			client.waitForPhase("boilerhouseclaims", claimName1, "Active"),
			client.waitForPhase("boilerhouseclaims", claimName2, "Active"),
		]);

		// Delete first claim
		await client.delete("boilerhouseclaims", claimName1);
		await client.waitForDeletion("boilerhouseclaims", claimName1);

		// Second claim should still be Active
		const status2 = await client.getStatus("boilerhouseclaims", claimName2);
		expect(status2?.phase).toBe("Active");
	}, 180_000);
});
