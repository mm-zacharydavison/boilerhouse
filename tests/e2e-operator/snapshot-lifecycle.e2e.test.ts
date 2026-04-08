import { describe, test, expect, afterAll } from "bun:test";
import { getTestClient, uniqueName, CrdTracker, operatorApiUrl } from "./helpers";
import { httpserverWorkload, claim } from "./fixtures";

describe("snapshot-lifecycle", () => {
	const client = getTestClient();
	const tracker = new CrdTracker();

	afterAll(async () => {
		await tracker.cleanup(client);
	});

	test("create workload + claim, POST snapshot to operator API, verify 200", async () => {
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(httpserverWorkload(wlName));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		const claimName = uniqueName("claim");
		tracker.track("boilerhouseclaims", claimName);
		await client.applyClaim(claim(claimName, "tenant-snapshot", wlName));
		const status = await client.waitForPhase("boilerhouseclaims", claimName, "Active");

		const instanceId = status.instanceId as string;
		expect(instanceId).toBeDefined();

		// POST snapshot request to operator internal API
		const res = await fetch(`${operatorApiUrl}/api/v1/instances/${instanceId}/snapshot`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
		});

		expect(res.status).toBe(200);
	}, 120_000);
});
