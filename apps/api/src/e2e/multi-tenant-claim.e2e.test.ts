import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { availableRuntimes, E2E_TIMEOUTS } from "./runtime-matrix";
import { startE2EServer, api, readFixture, waitForWorkloadReady, type E2EServer } from "./e2e-helpers";

for (const rt of availableRuntimes()) {
	const timeouts = E2E_TIMEOUTS[rt.name as keyof typeof E2E_TIMEOUTS] ?? E2E_TIMEOUTS.fake;

	describe(`[${rt.name}] multi-tenant claim`, () => {
		let server: E2EServer;
		let workloadName: string;

		beforeAll(async () => {
			server = await startE2EServer(rt.name);
			const fixture = await readFixture(rt.workloadFixtures.httpserver);

			const registerRes = await api(server, "POST", "/api/v1/workloads", fixture);
			expect(registerRes.status).toBe(201);
			const body = await registerRes.json();
			workloadName = body.name;

			await waitForWorkloadReady(server, workloadName);
		}, timeouts.operation);

		afterAll(async () => {
			if (server) await server.cleanup();
		});

		test("two different tenants can claim the same workload sequentially", async () => {
			// Tenant 1 claims
			const claim1Res = await api(server, "POST", "/api/v1/tenants/e2e-zac/claim", {
				workload: workloadName,
			});
			expect(claim1Res.status).toBe(200);
			const claim1Body = await claim1Res.json();
			expect(claim1Body.source).toBe("golden");
			expect(claim1Body.instanceId).toBeDefined();

			// Tenant 2 claims the same workload
			const claim2Res = await api(server, "POST", "/api/v1/tenants/e2e-zac2/claim", {
				workload: workloadName,
			});
			expect(claim2Res.status).toBe(200);
			const claim2Body = await claim2Res.json();
			expect(claim2Body.source).toBe("golden");
			expect(claim2Body.instanceId).toBeDefined();

			// Instance IDs must be distinct
			expect(claim2Body.instanceId).not.toBe(claim1Body.instanceId);

			// Both tenants should have active instances
			const tenant1Res = await api(server, "GET", "/api/v1/tenants/e2e-zac");
			expect(tenant1Res.status).toBe(200);
			const tenant1 = await tenant1Res.json();
			expect(tenant1.instanceId).toBe(claim1Body.instanceId);

			const tenant2Res = await api(server, "GET", "/api/v1/tenants/e2e-zac2");
			expect(tenant2Res.status).toBe(200);
			const tenant2 = await tenant2Res.json();
			expect(tenant2.instanceId).toBe(claim2Body.instanceId);

			// Verify 2 active instances exist
			const activeRes = await api(server, "GET", "/api/v1/instances?status=active");
			expect(activeRes.status).toBe(200);
			const activeInstances = await activeRes.json();
			expect(activeInstances.length).toBe(2);

			// Release both
			const release1 = await api(server, "POST", "/api/v1/tenants/e2e-zac/release");
			expect(release1.status).toBe(200);

			const release2 = await api(server, "POST", "/api/v1/tenants/e2e-zac2/release");
			expect(release2.status).toBe(200);
		}, timeouts.operation);
	});
}
