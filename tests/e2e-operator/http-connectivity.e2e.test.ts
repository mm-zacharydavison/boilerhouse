import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { getTestClient, uniqueName, CrdTracker, kubectlPortForward, type KubeTestClient } from "./helpers";
import { httpserverWorkload, claim } from "./fixtures";

describe("http-connectivity", () => {
	let client: KubeTestClient;
	const tracker = new CrdTracker();
	let portForwardHandle: { localPort: number; stop: () => void } | null = null;

	beforeAll(() => {
		client = getTestClient();
	});

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

		// Fetch HTTP response (retry — nc-based server has brief gaps between connections)
		let res: Response | null = null;
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				res = await fetch(`http://127.0.0.1:${portForwardHandle.localPort}/`);
				break;
			} catch {
				await new Promise((r) => setTimeout(r, 1_000));
			}
		}
		expect(res).not.toBeNull();
		expect(res!.status).toBe(200);

		const body = await res!.text();
		expect(body.length).toBeGreaterThan(0);
	}, 120_000);
});
