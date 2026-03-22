import { eq } from "drizzle-orm";
import type { WorkloadId, Workload } from "@boilerhouse/core";
import { WorkQueue } from "@boilerhouse/core";
import type { DrizzleDb } from "@boilerhouse/db";
import { workloads } from "@boilerhouse/db";
import type { Logger } from "@boilerhouse/o11y";
import type { SnapshotManager } from "./snapshot-manager";
import type { EventBus } from "./event-bus";
import type { BootstrapLogStore } from "./bootstrap-log-store";
import { applyWorkloadTransition } from "./transitions";

export class GoldenCreator {
	private readonly queue: WorkQueue<{ workloadId: WorkloadId; workload: Workload }>;

	/**
	 * @param maxConcurrency Maximum number of golden snapshots to create in parallel.
	 *   @default 5
	 */
	constructor(
		private readonly db: DrizzleDb,
		private readonly snapshotManager: SnapshotManager,
		private readonly eventBus: EventBus,
		private readonly bootstrapLogStore?: BootstrapLogStore,
		private readonly log?: Logger,
		maxConcurrency = 5,
	) {
		this.queue = new WorkQueue({
			concurrency: maxConcurrency,
			key: (item) => item.workloadId,
			process: (item) => this.processItem(item.workloadId, item.workload),
			onError: (err) => this.log?.error({ err }, "Unexpected queue error"),
		});
	}

	/** Enqueue a workload for background golden snapshot creation. */
	enqueue(workloadId: WorkloadId, workload: Workload): void {
		this.bootstrapLogStore?.clear(workloadId);
		this.queue.enqueue({ workloadId, workload });
	}

	/** Number of items waiting in the queue (not including the current one). */
	get pending(): number {
		return this.queue.pending;
	}

	/** Whether the creator is currently processing an item. */
	get isProcessing(): boolean {
		return this.queue.isProcessing;
	}

	private async processItem(workloadId: WorkloadId, workload: Workload): Promise<void> {
		const onLog = (line: string): void => {
			if (this.bootstrapLogStore) {
				const entry = this.bootstrapLogStore.append(workloadId, line);
				this.eventBus.emit({
					type: "bootstrap.log",
					workloadId,
					line,
					timestamp: entry.timestamp,
				});
			}
		};

		// Runtime doesn't support golden snapshots — mark ready immediately
		if (!this.snapshotManager.capabilities.goldenSnapshots) {
			applyWorkloadTransition(this.db, workloadId, "creating", "created");

			this.eventBus.emit({
				type: "workload.state",
				workloadId,
				status: "ready",
			});

			this.log?.info({ workloadId }, "Workload ready (no golden snapshot — runtime does not support them)");
			return;
		}

		try {
			onLog("Creating golden snapshot...");
			await this.snapshotManager.createGolden(workloadId, workload, onLog);
			applyWorkloadTransition(this.db, workloadId, "creating", "created");
			onLog("Golden snapshot ready.");

			this.eventBus.emit({
				type: "workload.state",
				workloadId,
				status: "ready",
			});

			this.log?.info({ workloadId }, "Golden snapshot ready");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			onLog(`ERROR: ${message}`);
			this.log?.error({ workloadId, err }, "Failed to create golden snapshot");

			try {
				applyWorkloadTransition(this.db, workloadId, "creating", "failed");
				this.db
					.update(workloads)
					.set({ statusDetail: message })
					.where(eq(workloads.workloadId, workloadId))
					.run();
			} catch {
				// Workload may have been deleted while processing
			}

			this.eventBus.emit({
				type: "workload.state",
				workloadId,
				status: "error",
			});
		}
	}
}
