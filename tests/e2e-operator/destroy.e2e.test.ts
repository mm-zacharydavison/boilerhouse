import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { getTestClient, uniqueName, CrdTracker, type KubeTestClient } from "./helpers";
import { httpserverWorkload, claim } from "./fixtures";

describe("destroy", () => {
	let client: KubeTestClient;
	const tracker = new CrdTracker();

	beforeAll(() => {
		client = getTestClient();
	});

	afterAll(async () => {
		await tracker.cleanup(client);
	});

	test("delete workload with active claim is blocked by finalizer; delete claim first, then workload succeeds", async () => {
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(httpserverWorkload(wlName));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		const claimName = uniqueName("claim");
		tracker.track("boilerhouseclaims", claimName);
		await client.applyClaim(claim(claimName, "tenant-destroy", wlName));
		await client.waitForPhase("boilerhouseclaims", claimName, "Active");

		// Attempt to delete workload — should be blocked by finalizer (still exists after short wait)
		await client.delete("boilerhouseworkloads", wlName);
		await new Promise((r) => setTimeout(r, 5_000));

		// Workload should still exist (finalizer blocks deletion while claim is active)
		const wlStatus = await client.getStatus("boilerhouseworkloads", wlName);
		expect(wlStatus).toBeDefined();

		// Delete claim first
		await client.delete("boilerhouseclaims", claimName);
		await client.waitForDeletion("boilerhouseclaims", claimName);

		// Now workload deletion should complete
		await client.waitForDeletion("boilerhouseworkloads", wlName, 30_000);
	}, 120_000);
});
