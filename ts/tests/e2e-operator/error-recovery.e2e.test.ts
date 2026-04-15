import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { getTestClient, uniqueName, CrdTracker, POLL_INITIAL_MS, POLL_MAX_MS, POLL_BACKOFF, type KubeTestClient } from "./helpers";
import { brokenWorkload, httpserverWorkload, claim } from "./fixtures";

describe("error-recovery", () => {
	let client: KubeTestClient;
	const tracker = new CrdTracker();

	beforeAll(() => {
		client = getTestClient();
	});

	afterAll(async () => {
		await tracker.cleanup(client);
	});

	test("broken workload enters Error phase when claimed; valid workload still works alongside it", async () => {
		// Create broken workload — spec is valid so it reconciles to Ready
		const brokenName = uniqueName("broken");
		tracker.track("boilerhouseworkloads", brokenName);
		await client.applyWorkload(brokenWorkload(brokenName));
		await client.waitForPhase("boilerhouseworkloads", brokenName, "Ready");

		// Claiming the broken workload should fail (bad image can't start a pod)
		const brokenClaimName = uniqueName("claim");
		tracker.track("boilerhouseclaims", brokenClaimName);
		await client.applyClaim(claim(brokenClaimName, "tenant-err-broken", brokenName));

		const deadline = Date.now() + 90_000;
		let brokenClaimStatus: Record<string, unknown> | undefined;
		let interval = POLL_INITIAL_MS;
		while (Date.now() < deadline) {
			brokenClaimStatus = await client.getStatus("boilerhouseclaims", brokenClaimName);
			if (brokenClaimStatus?.phase === "Error") break;
			await new Promise((r) => setTimeout(r, interval));
			interval = Math.min(interval * POLL_BACKOFF, POLL_MAX_MS);
		}

		expect(brokenClaimStatus?.phase).toBe("Error");
		expect(brokenClaimStatus?.detail).toBeDefined();
		expect(typeof brokenClaimStatus?.detail).toBe("string");
		expect((brokenClaimStatus!.detail as string).length).toBeGreaterThan(0);

		// Valid workload should still work alongside the broken one
		const validName = uniqueName("valid");
		tracker.track("boilerhouseworkloads", validName);
		await client.applyWorkload(httpserverWorkload(validName));
		await client.waitForPhase("boilerhouseworkloads", validName, "Ready");

		const claimName = uniqueName("claim");
		tracker.track("boilerhouseclaims", claimName);
		await client.applyClaim(claim(claimName, "tenant-err", validName));
		await client.waitForPhase("boilerhouseclaims", claimName, "Active");
	}, 120_000);
});
