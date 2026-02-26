import { describe, test, expect, afterEach, setDefaultTimeout } from "bun:test";
import { availableRuntimes, E2E_TIMEOUTS } from "./runtime-matrix";
import {
	startE2EServer,
	api,
	readFixture,
	waitForWorkloadReady,
	type E2EServer,
} from "./e2e-helpers";

for (const rt of availableRuntimes()) {
	const timeouts =
		E2E_TIMEOUTS[rt.name as keyof typeof E2E_TIMEOUTS] ?? E2E_TIMEOUTS.fake;

	describe(`[${rt.name}] instance actions (dashboard)`, () => {
		// Podman container cleanup in afterEach can exceed the default 5s hook timeout
		setDefaultTimeout(timeouts.operation);

		let server: E2EServer;

		afterEach(async () => {
			if (server) await server.cleanup();
		});

		/**
		 * Helper: register a workload, wait for ready, claim a tenant, return
		 * the workloadName and instanceId for further action testing.
		 */
		async function setupActiveInstance(tenantId: string) {
			const toml = await readFixture(rt.workloadFixtures.httpserver);

			const registerRes = await api(server, "POST", "/api/v1/workloads", toml);
			expect(registerRes.status).toBe(201);
			const { name: workloadName } = await registerRes.json();

			await waitForWorkloadReady(server, workloadName);

			const claimRes = await api(
				server,
				"POST",
				`/api/v1/tenants/${tenantId}/claim`,
				{ workload: workloadName },
			);
			expect(claimRes.status).toBe(200);
			const { instanceId } = (await claimRes.json()) as {
				instanceId: string;
			};

			// Sanity: instance should be active
			const instanceRes = await api(
				server,
				"GET",
				`/api/v1/instances/${instanceId}`,
			);
			expect(instanceRes.status).toBe(200);
			expect((await instanceRes.json()).status).toBe("active");

			return { workloadName, instanceId };
		}

		// ── Hibernate ────────────────────────────────────────────────────

		test.skipIf(!rt.capabilities.snapshot)(
			"hibernate active instance directly",
			async () => {
				server = await startE2EServer(rt.name);
				const { instanceId } = await setupActiveInstance("e2e-hib-1");

				// Hibernate
				const hibRes = await api(
					server,
					"POST",
					`/api/v1/instances/${instanceId}/hibernate`,
				);
				expect(hibRes.status).toBe(200);
				const hibBody = await hibRes.json();
				expect(hibBody.snapshotId).toBeDefined();

				// Instance should be hibernated
				const instanceRes = await api(
					server,
					"GET",
					`/api/v1/instances/${instanceId}`,
				);
				expect(instanceRes.status).toBe(200);
				expect((await instanceRes.json()).status).toBe("hibernated");

				// Tenant should be dissociated
				const tenantRes = await api(
					server,
					"GET",
					"/api/v1/tenants/e2e-hib-1",
				);
				expect(tenantRes.status).toBe(200);
				const tenant = await tenantRes.json();
				expect(tenant.instanceId).toBeNull();
				expect(tenant.lastSnapshotId).toBe(hibBody.snapshotId);

				// Snapshot should exist
				const snapshotsRes = await api(server, "GET", "/api/v1/snapshots");
				expect(snapshotsRes.status).toBe(200);
				const snapshots = (await snapshotsRes.json()) as {
					snapshotId: string;
					type: string;
				}[];
				const tenantSnap = snapshots.find(
					(s) => s.snapshotId === hibBody.snapshotId,
				);
				expect(tenantSnap).toBeDefined();
			},
			timeouts.operation,
		);

		// ── Destroy ──────────────────────────────────────────────────────

		test(
			"destroy active instance directly",
			async () => {
				server = await startE2EServer(rt.name);
				const { instanceId } = await setupActiveInstance("e2e-dest-1");

				// Destroy
				const destroyRes = await api(
					server,
					"POST",
					`/api/v1/instances/${instanceId}/destroy`,
				);
				expect(destroyRes.status).toBe(200);
				expect((await destroyRes.json()).status).toBe("destroyed");

				// Instance should be destroyed
				const instanceRes = await api(
					server,
					"GET",
					`/api/v1/instances/${instanceId}`,
				);
				expect(instanceRes.status).toBe(200);
				expect((await instanceRes.json()).status).toBe("destroyed");

				// Tenant should be dissociated
				const tenantRes = await api(
					server,
					"GET",
					"/api/v1/tenants/e2e-dest-1",
				);
				expect(tenantRes.status).toBe(200);
				expect((await tenantRes.json()).instanceId).toBeNull();

				// Runtime resources should be cleaned up
				const isRunning = await rt.isInstanceRunning(instanceId);
				expect(isRunning).toBe(false);
			},
			timeouts.operation,
		);

		test.skipIf(!rt.capabilities.snapshot)(
			"destroy hibernated instance",
			async () => {
				server = await startE2EServer(rt.name);
				const { instanceId } = await setupActiveInstance("e2e-dest-hib-1");

				// First hibernate
				const hibRes = await api(
					server,
					"POST",
					`/api/v1/instances/${instanceId}/hibernate`,
				);
				expect(hibRes.status).toBe(200);

				// Then destroy the hibernated instance
				const destroyRes = await api(
					server,
					"POST",
					`/api/v1/instances/${instanceId}/destroy`,
				);
				expect(destroyRes.status).toBe(200);
				expect((await destroyRes.json()).status).toBe("destroyed");

				// Verify destroyed
				const instanceRes = await api(
					server,
					"GET",
					`/api/v1/instances/${instanceId}`,
				);
				expect(instanceRes.status).toBe(200);
				expect((await instanceRes.json()).status).toBe("destroyed");
			},
			timeouts.operation,
		);

		// ── Invalid transitions (409) ────────────────────────────────────

		test.skipIf(!rt.capabilities.snapshot)(
			"hibernate already-hibernated instance returns 409",
			async () => {
				server = await startE2EServer(rt.name);
				const { instanceId } = await setupActiveInstance("e2e-hib-dup-1");

				// First hibernate succeeds
				const hib1 = await api(
					server,
					"POST",
					`/api/v1/instances/${instanceId}/hibernate`,
				);
				expect(hib1.status).toBe(200);

				// Second hibernate should fail with 409
				const hib2 = await api(
					server,
					"POST",
					`/api/v1/instances/${instanceId}/hibernate`,
				);
				expect(hib2.status).toBe(409);
			},
			timeouts.operation,
		);

		test(
			"destroy already-destroyed instance returns 409",
			async () => {
				server = await startE2EServer(rt.name);
				const { instanceId } = await setupActiveInstance("e2e-dest-dup-1");

				// First destroy succeeds
				const dest1 = await api(
					server,
					"POST",
					`/api/v1/instances/${instanceId}/destroy`,
				);
				expect(dest1.status).toBe(200);

				// Second destroy should fail with 409
				const dest2 = await api(
					server,
					"POST",
					`/api/v1/instances/${instanceId}/destroy`,
				);
				expect(dest2.status).toBe(409);
			},
			timeouts.operation,
		);

		// ── Endpoint ─────────────────────────────────────────────────────

		test(
			"get endpoint for active instance",
			async () => {
				server = await startE2EServer(rt.name);
				const { instanceId } = await setupActiveInstance("e2e-ep-1");

				const epRes = await api(
					server,
					"GET",
					`/api/v1/instances/${instanceId}/endpoint`,
				);
				expect(epRes.status).toBe(200);
				const epBody = await epRes.json();
				expect(epBody.endpoint).toBeDefined();
				expect(epBody.endpoint.host).toBeDefined();

				// If the runtime supports networking and ports are exposed, verify reachability
				if (
					rt.capabilities.networking &&
					epBody.endpoint?.ports?.length > 0
				) {
					const { host, ports } = epBody.endpoint;
					const resp = await fetch(`http://${host}:${ports[0]}`);
					expect(resp.ok).toBe(true);
				}
			},
			timeouts.operation,
		);

		test(
			"get endpoint for destroyed instance returns 409",
			async () => {
				server = await startE2EServer(rt.name);
				const { instanceId } = await setupActiveInstance("e2e-ep-dead-1");

				// Destroy first
				const destroyRes = await api(
					server,
					"POST",
					`/api/v1/instances/${instanceId}/destroy`,
				);
				expect(destroyRes.status).toBe(200);

				// Endpoint on destroyed instance should fail
				const epRes = await api(
					server,
					"GET",
					`/api/v1/instances/${instanceId}/endpoint`,
				);
				expect(epRes.status).toBe(409);
			},
			timeouts.operation,
		);
	});
}
