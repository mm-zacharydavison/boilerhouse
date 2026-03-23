import { Elysia } from "elysia";
import type { RouteDeps } from "./deps";

export function activityRoutes(deps: RouteDeps) {
	const { activityLog } = deps;

	return new Elysia({ name: "activity" }).get("/audit", ({ query }) => {
		const rawLimit = Number(query.limit) || 200;
		const limit = Math.min(Math.max(1, rawLimit), 500);

		const rows = activityLog.queryRecent(limit);

		return rows.map((row) => ({
			id: row.id,
			event: row.event,
			instanceId: row.instanceId,
			workloadId: row.workloadId,
			nodeId: row.nodeId,
			tenantId: row.tenantId,
			metadata: row.metadata,
			createdAt: row.createdAt.toISOString(),
		}));
	});
}
