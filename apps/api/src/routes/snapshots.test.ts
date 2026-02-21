import { describe, test, expect } from "bun:test";
import { generateWorkloadId } from "@boilerhouse/core";
import type { Workload } from "@boilerhouse/core";
import { workloads } from "@boilerhouse/db";
import { createTestApp, apiRequest } from "../test-helpers";

const MINIMAL_WORKLOAD: Workload = {
	workload: { name: "snap-test", version: "1.0.0" },
	image: { ref: "ghcr.io/test:latest" },
	resources: { vcpus: 1, memory_mb: 512, disk_gb: 2 },
	network: { access: "none" },
	idle: { action: "hibernate" },
};

describe("GET /api/v1/snapshots", () => {
	test("returns empty list when no snapshots exist", async () => {
		const { app } = createTestApp();
		const res = await apiRequest(app, "/api/v1/snapshots");

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});

	test("returns all snapshots across workloads", async () => {
		const { app, db, snapshotManager } = createTestApp();

		const workloadId = generateWorkloadId();
		db.insert(workloads)
			.values({
				workloadId,
				name: "snap-test",
				version: "1.0.0",
				config: MINIMAL_WORKLOAD,
				createdAt: new Date(),
				updatedAt: new Date(),
			})
			.run();

		await snapshotManager.createGolden(workloadId, MINIMAL_WORKLOAD);

		const res = await apiRequest(app, "/api/v1/snapshots");
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body).toHaveLength(1);
		expect(body[0].type).toBe("golden");
		expect(body[0].workloadId).toBe(workloadId);
		expect(body[0].snapshotId).toBeDefined();
		expect(body[0].nodeId).toBeDefined();
		expect(body[0].createdAt).toBeDefined();
	});
});
