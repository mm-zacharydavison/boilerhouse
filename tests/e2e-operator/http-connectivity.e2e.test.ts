import { describe, test, expect, afterAll } from "bun:test";
import { getTestClient, uniqueName, CrdTracker, kubectlPortForward } from "./helpers";
import { httpserverWorkload, claim } from "./fixtures";

describe("http-connectivity", () => {
	const client = getTestClient();
	const tracker = new CrdTracker();
	let portForwardHandle: { localPort: number; stop: () => void } | null = null;

	afterAll(async () => {
		if (portForwardHandle) portForwardHandle.stop();
		await tracker.cleanup(client);
	});

	test("claim httpserver workload, port-forward, fetch HTTP response, verify 200 + HTML", async () => {
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(httpserverWorkload(wlName));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		const claimName = uniqueName("claim");
		tracker.track("boilerhouseclaims", claimName);
		await client.applyClaim(claim(claimName, "tenant-http", wlName));
		const status = await client.waitForPhase("boilerhouseclaims", claimName, "Active");

		const instanceId = status.instanceId as string;
		expect(instanceId).toBeDefined();

		// Port-forward to the pod
		portForwardHandle = await kubectlPortForward(instanceId, 8080);

		// Fetch HTTP response
		const res = await fetch(`http://127.0.0.1:${portForwardHandle.localPort}/`);
		expect(res.status).toBe(200);

		const body = await res.text();
		expect(body).toContain("<!DOCTYPE");
	}, 120_000);
});
