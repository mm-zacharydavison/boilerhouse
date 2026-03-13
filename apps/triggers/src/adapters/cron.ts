import { Cron } from "croner";
import type { TriggerDefinition, CronConfig } from "../config";
import type { Dispatcher } from "../dispatcher";
import { resolveTenantId } from "../resolve-tenant";

type CronTrigger = TriggerDefinition & { config: CronConfig };

export class CronAdapter {
	private jobs: Cron[] = [];

	start(triggers: CronTrigger[], dispatcher: Dispatcher): void {
		for (const trigger of triggers) {
			// Cron has no external event — resolve tenant from empty context.
			// Only { static: "..." } mappings will work here.
			const tenantId = resolveTenantId(trigger.tenant, {});
			const job = new Cron(trigger.config.schedule, () => {
				dispatcher
					.dispatch({
						triggerName: trigger.name,
						tenantId,
						workload: trigger.workload,
						payload: trigger.config.payload ?? {},
					})
					.catch((err) => {
						console.error(
							`[cron] trigger "${trigger.name}" failed:`,
							err instanceof Error ? err.message : err,
						);
					});
			});
			this.jobs.push(job);
		}
	}

	stop(): void {
		for (const job of this.jobs) job.stop();
		this.jobs = [];
	}
}
