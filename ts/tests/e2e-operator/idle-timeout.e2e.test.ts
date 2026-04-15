import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { getTestClient, uniqueName, CrdTracker, type KubeTestClient } from "./helpers";
import { idleWorkload, claim } from "./fixtures";

describe("idle-timeout", () => {
	let client: KubeTestClient;
	const tracker = new CrdTracker();

	beforeAll(() => {
		client = getTestClient();
	});

	afterAll(async () => {
		await tracker.cleanup(client);
	});

	test("claim with short idle timeout (5s) transitions to Released phase", async () => {
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(idleWorkload(wlName, 5));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		const claimName = uniqueName("claim");
		tracker.track("boilerhouseclaims", claimName);
		await client.applyClaim(claim(claimName, "tenant-idle", wlName));
		await client.waitForPhase("boilerhouseclaims", claimName, "Active");

		// Wait for operator to release the claim after idle timeout
		const status = await client.waitForPhase("boilerhouseclaims", claimName, "Released", 60_000);
		expect(status.phase).toBe("Released");
	}, 120_000);
});
