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

		// Attempt to delete workload — should be blocked by finalizer
		await client.delete("boilerhouseworkloads", wlName);

		// Poll to confirm workload still exists (finalizer blocks deletion while claim is active)
		// Check multiple times over a few seconds to verify it stays blocked
		for (let i = 0; i < 5; i++) {
			await new Promise((r) => setTimeout(r, 500));
			const wlStatus = await client.getStatus("boilerhouseworkloads", wlName);
			expect(wlStatus).toBeDefined();
		}

		// Delete claim first
		await client.delete("boilerhouseclaims", claimName);
		await client.waitForDeletion("boilerhouseclaims", claimName);

		// Now workload deletion should complete (claim release destroys the pod, which takes time)
		await client.waitForDeletion("boilerhouseworkloads", wlName, 90_000);
	}, 150_000);
});
