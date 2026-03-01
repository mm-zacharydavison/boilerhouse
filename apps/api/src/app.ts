import { Elysia } from "elysia";
import type { RouteDeps } from "./routes/deps";
import { errorHandler } from "./routes/errors";
import { systemRoutes } from "./routes/system";
import { workloadRoutes } from "./routes/workloads";
import { instanceRoutes } from "./routes/instances";
import { tenantRoutes } from "./routes/tenants";
import { nodeRoutes } from "./routes/nodes";
import { snapshotRoutes } from "./routes/snapshots";
import { activityRoutes } from "./routes/activity";
import { secretRoutes } from "./routes/secrets";
import { wsPlugin } from "./routes/ws";

export function createApp(deps: RouteDeps) {
	return new Elysia()
		.use(errorHandler)
		.group("/api/v1", (app) =>
			app
				.use(systemRoutes(deps))
				.use(workloadRoutes(deps))
				.use(instanceRoutes(deps))
				.use(tenantRoutes(deps))
				.use(nodeRoutes(deps))
				.use(snapshotRoutes(deps))
				.use(activityRoutes(deps))
				.use(secretRoutes(deps)),
		)
		.use(wsPlugin(deps));
}
