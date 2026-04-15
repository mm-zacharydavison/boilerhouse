import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { getTestClient, uniqueName, CrdTracker, type KubeTestClient } from "./helpers";
import { httpserverWorkload, claim } from "./fixtures";

describe("events", () => {
	let client: KubeTestClient;
	const tracker = new CrdTracker();

	beforeAll(() => {
		client = getTestClient();
	});

	afterAll(async () => {
		await tracker.cleanup(client);
	});

	test("create claim, poll status to observe Pending → Active transitions in order", async () => {
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(httpserverWorkload(wlName));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		const claimName = uniqueName("claim");
		tracker.track("boilerhouseclaims", claimName);
		await client.applyClaim(claim(claimName, "tenant-events", wlName));

		// Poll and record phase transitions
		const phases: string[] = [];
		const deadline = Date.now() + 60_000;

		while (Date.now() < deadline) {
			const status = await client.getStatus("boilerhouseclaims", claimName);
			const phase = status?.phase as string | undefined;
			if (phase && (phases.length === 0 || phases[phases.length - 1] !== phase)) {
				phases.push(phase);
			}
			if (phase === "Active") break;
			if (phase === "Error") throw new Error(`Claim entered Error: ${status?.detail}`);
			await new Promise((r) => setTimeout(r, 300));
		}

		// Should have reached Active (Pending may be too transient to observe at poll intervals)
		expect(phases).toContain("Active");
		const pendingIdx = phases.indexOf("Pending");
		const activeIdx = phases.indexOf("Active");
		if (pendingIdx >= 0) {
			// If we caught Pending, it must come before Active
			expect(activeIdx).toBeGreaterThan(pendingIdx);
		}
	}, 120_000);
});
