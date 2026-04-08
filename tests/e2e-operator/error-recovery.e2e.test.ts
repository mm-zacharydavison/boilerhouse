import { describe, test, expect, afterAll } from "bun:test";
import { getTestClient, uniqueName, CrdTracker } from "./helpers";
import { brokenWorkload, httpserverWorkload, claim } from "./fixtures";

describe("error-recovery", () => {
	const client = getTestClient();
	const tracker = new CrdTracker();

	afterAll(async () => {
		await tracker.cleanup(client);
	});

	test("broken workload enters Error phase with detail; valid workload still works alongside it", async () => {
		// Create broken workload
		const brokenName = uniqueName("broken");
		tracker.track("boilerhouseworkloads", brokenName);
		await client.applyWorkload(brokenWorkload(brokenName));

		// Wait for Error phase — waitForPhase throws on Error, so poll manually
		const deadline = Date.now() + 60_000;
		let brokenStatus: Record<string, unknown> | undefined;
		while (Date.now() < deadline) {
			brokenStatus = await client.getStatus("boilerhouseworkloads", brokenName);
			if (brokenStatus?.phase === "Error") break;
			await new Promise((r) => setTimeout(r, 1_000));
		}

		expect(brokenStatus?.phase).toBe("Error");
		expect(brokenStatus?.detail).toBeDefined();
		expect(typeof brokenStatus?.detail).toBe("string");
		expect((brokenStatus!.detail as string).length).toBeGreaterThan(0);

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
