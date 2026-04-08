import { describe, test, expect, afterAll } from "bun:test";
import { getTestClient, uniqueName, CrdTracker } from "./helpers";
import { httpserverWorkload, claim, pool } from "./fixtures";

describe("workload-update", () => {
	const client = getTestClient();
	const tracker = new CrdTracker();

	afterAll(async () => {
		await tracker.cleanup(client);
	});

	test("update workload spec, verify re-reconcile to Ready", async () => {
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(httpserverWorkload(wlName));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		// Update the workload spec (change version to trigger re-reconcile)
		const updated = httpserverWorkload(wlName);
		updated.spec.version = "2";
		(updated.spec as Record<string, unknown>).memoryMb = 256;
		await client.applyWorkload(updated);

		// Wait for re-reconcile back to Ready
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		const status = await client.getStatus("boilerhouseworkloads", wlName);
		expect(status?.phase).toBe("Ready");
	}, 120_000);

	test("existing claims are untouched after workload update", async () => {
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(httpserverWorkload(wlName));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		// Create a claim
		const claimName = uniqueName("claim");
		tracker.track("boilerhouseclaims", claimName);
		await client.applyClaim(claim(claimName, "tenant-update", wlName));
		const statusBefore = await client.waitForPhase("boilerhouseclaims", claimName, "Active");
		const instanceIdBefore = statusBefore.instanceId as string;

		// Update the workload
		const updated = httpserverWorkload(wlName);
		updated.spec.version = "2";
		(updated.spec as Record<string, unknown>).memoryMb = 256;
		await client.applyWorkload(updated);
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		// Claim should still be Active with same instanceId
		const statusAfter = await client.getStatus("boilerhouseclaims", claimName);
		expect(statusAfter?.phase).toBe("Active");
		expect(statusAfter?.instanceId).toBe(instanceIdBefore);
	}, 120_000);

	test("pool re-stabilizes after workload update", async () => {
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(httpserverWorkload(wlName));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		// Create a pool
		const poolName = uniqueName("pool");
		tracker.track("boilerhousepools", poolName);
		await client.applyPool(pool(poolName, wlName, 2));
		await client.waitForPhase("boilerhousepools", poolName, "Ready");

		// Update the workload
		const updated = httpserverWorkload(wlName);
		updated.spec.version = "2";
		(updated.spec as Record<string, unknown>).memoryMb = 256;
		await client.applyWorkload(updated);
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		// Pool should re-stabilize to Ready
		await client.waitForPhase("boilerhousepools", poolName, "Ready", 180_000);

		const poolStatus = await client.getStatus("boilerhousepools", poolName);
		expect(poolStatus?.phase).toBe("Ready");
		expect(poolStatus?.ready).toBe(2);
	}, 180_000);
});
