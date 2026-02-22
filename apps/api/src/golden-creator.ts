import { eq } from "drizzle-orm";
import type { WorkloadId, Workload } from "@boilerhouse/core";
import type { DrizzleDb } from "@boilerhouse/db";
import { workloads } from "@boilerhouse/db";
import type { SnapshotManager } from "./snapshot-manager";
import type { EventBus } from "./event-bus";
import type { ImageBuilder } from "./image-builder";
import type { BuildLogStore } from "./build-log-store";
import { applyWorkloadTransition } from "./transitions";

export class GoldenCreator {
	/** Insertion-ordered map acts as both FIFO queue and dedup set. */
	private readonly queue = new Map<WorkloadId, Workload>();
	private processing = false;

	constructor(
		private readonly db: DrizzleDb,
		private readonly snapshotManager: SnapshotManager,
		private readonly eventBus: EventBus,
		private readonly imageBuilder?: ImageBuilder,
		private readonly buildLogStore?: BuildLogStore,
	) {}

	/** Enqueue a workload for background golden snapshot creation. */
	enqueue(workloadId: WorkloadId, workload: Workload): void {
		if (this.queue.has(workloadId)) return;
		this.buildLogStore?.clear(workloadId);
		this.queue.set(workloadId, workload);
		if (!this.processing) {
			this.processQueue();
		}
	}

	/** Number of items waiting in the queue (not including the current one). */
	get pending(): number {
		return this.queue.size;
	}

	/** Whether the creator is currently processing an item. */
	get isProcessing(): boolean {
		return this.processing;
	}

	private processQueue(): void {
		// Fire-and-forget — errors are handled internally per item
		this.processQueueAsync().catch((err) => {
			console.error("GoldenCreator: unexpected queue error:", err);
		});
	}

	private async processQueueAsync(): Promise<void> {
		if (this.processing) return;
		this.processing = true;

		try {
			while (this.queue.size > 0) {
				const [workloadId, workload] = this.queue.entries().next().value!;
				this.queue.delete(workloadId);
				await this.processItem(workloadId, workload);
			}
		} finally {
			this.processing = false;
		}
	}

	private async processItem(workloadId: WorkloadId, workload: Workload): Promise<void> {
		const onLog = (line: string): void => {
			if (this.buildLogStore) {
				const entry = this.buildLogStore.append(workloadId, line);
				this.eventBus.emit({
					type: "build.log",
					workloadId,
					line,
					timestamp: entry.timestamp,
				});
			}
		};

		try {
			if (this.imageBuilder) {
				await this.imageBuilder.ensureRootfs(workload, onLog);
			}

			onLog("Creating golden snapshot...");
			await this.snapshotManager.createGolden(workloadId, workload, onLog);
			applyWorkloadTransition(this.db, workloadId, "creating", "created");
			onLog("Golden snapshot ready.");

			this.eventBus.emit({
				type: "workload.state",
				workloadId,
				status: "ready",
			});

			console.log(`GoldenCreator: golden snapshot ready for workload ${workloadId}`);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			onLog(`ERROR: ${message}`);
			console.error(
				`GoldenCreator: failed to create golden snapshot for workload ${workloadId}: ${message}`,
			);

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
