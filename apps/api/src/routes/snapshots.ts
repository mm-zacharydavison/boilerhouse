import { Elysia } from "elysia";
import { snapshots } from "@boilerhouse/db";
import type { RouteDeps } from "./deps";

export function snapshotRoutes(deps: RouteDeps) {
	const { db } = deps;

	return new Elysia({ name: "snapshots" }).get("/snapshots", () => {
		const rows = db.select().from(snapshots).all();
		return rows.map((s) => ({
			snapshotId: s.snapshotId,
			type: s.type,
			instanceId: s.instanceId,
			tenantId: s.tenantId,
			workloadId: s.workloadId,
			nodeId: s.nodeId,
			sizeBytes: s.sizeBytes,
			createdAt: s.createdAt.toISOString(),
		}));
	});
}
