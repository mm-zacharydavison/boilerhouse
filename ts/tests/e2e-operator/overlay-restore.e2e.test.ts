import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { getTestClient, uniqueName, CrdTracker, kubectlExec, type KubeTestClient } from "./helpers";
import { overlayWorkload, claim } from "./fixtures";

describe("overlay-restore", () => {
	let client: KubeTestClient;
	const tracker = new CrdTracker();

	beforeAll(() => {
		client = getTestClient();
	});

	afterAll(async () => {
		await tracker.cleanup(client);
	});

	test("overlay workload: write data, release, re-claim, verify data + status.source includes +data", async () => {
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(overlayWorkload(wlName));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		// First claim — write data
		const claimName1 = uniqueName("claim");
		tracker.track("boilerhouseclaims", claimName1);
		await client.applyClaim(claim(claimName1, "tenant-overlay", wlName));
		const status1 = await client.waitForPhase("boilerhouseclaims", claimName1, "Active");

		const instanceId1 = status1.instanceId as string;
		const writeResult = await kubectlExec(instanceId1, [
			"sh", "-c", "echo 'overlay-test-data' > /data/overlay-file.txt",
		]);
		expect(writeResult.exitCode).toBe(0);

		// Release
		await client.delete("boilerhouseclaims", claimName1);
		await client.waitForDeletion("boilerhouseclaims", claimName1);

		// Re-claim
		const claimName2 = uniqueName("claim");
		tracker.track("boilerhouseclaims", claimName2);
		await client.applyClaim(claim(claimName2, "tenant-overlay", wlName));
		const status2 = await client.waitForPhase("boilerhouseclaims", claimName2, "Active");

		// Verify data persisted
		const instanceId2 = status2.instanceId as string;
		const readResult = await kubectlExec(instanceId2, ["cat", "/data/overlay-file.txt"]);
		expect(readResult.exitCode).toBe(0);
		expect(readResult.stdout.trim()).toBe("overlay-test-data");

		// Check status.source includes "+data"
		expect(status2.source).toBeDefined();
		expect(typeof status2.source).toBe("string");
		expect(status2.source as string).toContain("+data");
	}, 120_000);
});
