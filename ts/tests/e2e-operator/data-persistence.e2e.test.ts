import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { getTestClient, uniqueName, CrdTracker, kubectlExec, type KubeTestClient } from "./helpers";
import { overlayWorkload, claim } from "./fixtures";

describe("data-persistence", () => {
	let client: KubeTestClient;
	const tracker = new CrdTracker();

	beforeAll(() => {
		client = getTestClient();
	});

	afterAll(async () => {
		await tracker.cleanup(client);
	});

	test("claim overlay workload, write file, release, re-claim, read file back", async () => {
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(overlayWorkload(wlName));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		// First claim — write data
		const claimName1 = uniqueName("claim");
		tracker.track("boilerhouseclaims", claimName1);
		await client.applyClaim(claim(claimName1, "tenant-persist", wlName));
		const status1 = await client.waitForPhase("boilerhouseclaims", claimName1, "Active");

		const instanceId1 = status1.instanceId as string;
		const writeResult = await kubectlExec(instanceId1, [
			"sh", "-c", "echo 'persistence-test-data' > /data/test-file.txt",
		]);
		expect(writeResult.exitCode).toBe(0);

		// Delete (release) first claim
		await client.delete("boilerhouseclaims", claimName1);
		await client.waitForDeletion("boilerhouseclaims", claimName1);

		// Re-claim same tenant + workload
		const claimName2 = uniqueName("claim");
		tracker.track("boilerhouseclaims", claimName2);
		await client.applyClaim(claim(claimName2, "tenant-persist", wlName));
		const status2 = await client.waitForPhase("boilerhouseclaims", claimName2, "Active");

		const instanceId2 = status2.instanceId as string;

		// Read the file back
		const readResult = await kubectlExec(instanceId2, ["cat", "/data/test-file.txt"]);
		expect(readResult.exitCode).toBe(0);
		expect(readResult.stdout.trim()).toBe("persistence-test-data");
	}, 120_000);
});
