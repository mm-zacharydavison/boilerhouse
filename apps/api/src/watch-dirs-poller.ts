import type { InstanceId } from "@boilerhouse/core";
import type { InstanceManager } from "./instance-manager";
import type { IdleMonitor } from "./idle-monitor";

/**
 * Polls watched directories inside running instances and forwards mtime
 * updates to the IdleMonitor, enabling filesystem-activity-based idle detection.
 *
 * When watch_dirs are configured on a workload, the idle timeout counts down
 * from the last observed file change rather than from instance creation.
 */
export class WatchDirsPoller {
	private readonly intervals = new Map<InstanceId, ReturnType<typeof setInterval>>();

	constructor(
		private readonly instanceManager: InstanceManager,
		private readonly idleMonitor: IdleMonitor,
		/** How often to exec stat inside each watched instance. */
		readonly pollIntervalMs: number = 5_000,
	) {}

	/**
	 * Starts polling `dirs` inside `instanceId` at `pollIntervalMs`.
	 * Replaces any existing polling for this instance.
	 */
	startPolling(instanceId: InstanceId, dirs: string[]): void {
		this.stopPolling(instanceId);

		const interval = setInterval(async () => {
			try {
				const mtime = await this.instanceManager.statWatchDirs(instanceId, dirs);
				// null means exec failed — skip reportActivity so the heartbeat expires
				if (mtime !== null) {
					this.idleMonitor.reportActivity(instanceId, mtime);
				}
			} catch {
				// Unexpected error — heartbeat will expire naturally
			}
		}, this.pollIntervalMs);

		this.intervals.set(instanceId, interval);
	}

	/** Stops polling for an instance. No-op if not polling. */
	stopPolling(instanceId: InstanceId): void {
		const interval = this.intervals.get(instanceId);
		if (interval) {
			clearInterval(interval);
			this.intervals.delete(instanceId);
		}
	}

	/** Stops all active polling intervals. */
	stopAll(): void {
		for (const [instanceId] of this.intervals) {
			this.stopPolling(instanceId);
		}
	}
}
