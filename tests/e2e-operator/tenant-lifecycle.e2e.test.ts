import { describe, test, expect, afterAll } from "bun:test";
import { getTestClient, uniqueName, CrdTracker } from "./helpers";
import { httpserverWorkload, claim } from "./fixtures";

describe("tenant-lifecycle", () => {
	const client = getTestClient();
	const tracker = new CrdTracker();

	afterAll(async () => {
		await tracker.cleanup(client);
	});

	test("claim transitions Pending→Active, delete claim, re-claim gets new instance", async () => {
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(httpserverWorkload(wlName));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		// First claim — observe Pending → Active
		const claimName1 = uniqueName("claim");
		tracker.track("boilerhouseclaims", claimName1);
		await client.applyClaim(claim(claimName1, "tenant-lc-2", wlName));

		// Poll until we see Active, recording phases along the way
		const phases: string[] = [];
		const deadline = Date.now() + 60_000;
		let status1: Record<string, unknown> | undefined;
		while (Date.now() < deadline) {
			status1 = await client.getStatus("boilerhouseclaims", claimName1);
			const phase = status1?.phase as string | undefined;
			if (phase && (phases.length === 0 || phases[phases.length - 1] !== phase)) {
				phases.push(phase);
			}
			if (phase === "Active") break;
			if (phase === "Error") throw new Error(`Claim entered Error: ${status1?.detail}`);
			await new Promise((r) => setTimeout(r, 500));
		}

		expect(phases).toContain("Pending");
		expect(phases[phases.length - 1]).toBe("Active");
		const firstInstanceId = status1!.instanceId as string;
		expect(firstInstanceId).toBeDefined();

		// Delete first claim
		await client.delete("boilerhouseclaims", claimName1);
		await client.waitForDeletion("boilerhouseclaims", claimName1);

		// Re-claim — should get a new instance
		const claimName2 = uniqueName("claim");
		tracker.track("boilerhouseclaims", claimName2);
		await client.applyClaim(claim(claimName2, "tenant-lc-2", wlName));
		const status2 = await client.waitForPhase("boilerhouseclaims", claimName2, "Active");

		const secondInstanceId = status2.instanceId as string;
		expect(secondInstanceId).toBeDefined();
		expect(secondInstanceId).not.toBe(firstInstanceId);
	}, 120_000);
});
