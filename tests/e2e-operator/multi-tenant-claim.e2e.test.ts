import { describe, test, expect, afterAll } from "bun:test";
import { getTestClient, uniqueName, CrdTracker } from "./helpers";
import { httpserverWorkload, claim } from "./fixtures";

describe("multi-tenant-claim", () => {
	const client = getTestClient();
	const tracker = new CrdTracker();

	afterAll(async () => {
		await tracker.cleanup(client);
	});

	test("two different tenants claim same workload, get distinct instances", async () => {
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(httpserverWorkload(wlName));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		const claimName1 = uniqueName("claim");
		const claimName2 = uniqueName("claim");
		tracker.track("boilerhouseclaims", claimName1);
		tracker.track("boilerhouseclaims", claimName2);

		await client.applyClaim(claim(claimName1, "tenant-mt-a", wlName));
		await client.applyClaim(claim(claimName2, "tenant-mt-b", wlName));

		const [status1, status2] = await Promise.all([
			client.waitForPhase("boilerhouseclaims", claimName1, "Active"),
			client.waitForPhase("boilerhouseclaims", claimName2, "Active"),
		]);

		expect(status1.instanceId).toBeDefined();
		expect(status2.instanceId).toBeDefined();
		expect(status1.instanceId).not.toBe(status2.instanceId);
	}, 120_000);
});
