import { statSync, readFileSync } from "node:fs";
import { eq, and } from "drizzle-orm";
import type {
	Runtime,
	InstanceId,
	WorkloadId,
	NodeId,
	SnapshotRef,
	Workload,
} from "@boilerhouse/core";
import { generateInstanceId } from "@boilerhouse/core";
import type { DrizzleDb } from "@boilerhouse/db";
import { snapshots, snapshotRefFrom } from "@boilerhouse/db";
import { applySnapshotTransition } from "./transitions";
import { pollHealth, createVsockCheck } from "./health-check";
import type { HealthConfig, HealthCheckFn, VsockCheckHandle } from "./health-check";

export type HealthChecker = (check: HealthCheckFn, config: HealthConfig, onLog?: (line: string) => void) => Promise<void>;

export interface SnapshotManagerOptions {
	/**
	 * Override the health checker for testing.
	 * @default pollHealth
	 */
	healthChecker?: HealthChecker;
	/**
	 * Default health check timeout in ms, used when the workload
	 * doesn't specify enough info to derive one.
	 * @default 120000
	 */
	defaultHealthTimeoutMs?: number;
}

export class SnapshotManager {
	private readonly healthChecker: HealthChecker;
	private readonly defaultHealthTimeoutMs: number;

	constructor(
		private readonly runtime: Runtime,
		private readonly db: DrizzleDb,
		private readonly nodeId: NodeId,
		options?: SnapshotManagerOptions,
	) {
		this.healthChecker = options?.healthChecker ?? pollHealth;
		this.defaultHealthTimeoutMs = options?.defaultHealthTimeoutMs ?? 120_000;
	}

	/**
	 * Creates a golden snapshot for a workload on this node.
	 *
	 * Cold boots a VM, waits for it to become healthy, takes a snapshot,
	 * then destroys the bootstrap VM. Uses upsert semantics — only one
	 * golden snapshot per workload+node combination is kept.
	 */
	async createGolden(
		workloadId: WorkloadId,
		workload: Workload,
		onLog?: (line: string) => void,
	): Promise<SnapshotRef> {
		const log = onLog ?? (() => {});
		const instanceId: InstanceId = generateInstanceId();

		log("Creating bootstrap VM...");
		const handle = await this.runtime.create(workload, instanceId);

		log("Starting bootstrap VM...");
		await this.runtime.start(handle);

		let vsockHandle: VsockCheckHandle | undefined;
		try {
			// Poll health probe if the workload defines one.
			// Both http_get and exec probes run inside the guest VM and
			// report back via vsock (like Docker HEALTHCHECK).
			if (workload.health) {
				const intervalMs = workload.health.interval_seconds * 1000;

				const vsockUdsPath = handle.meta?.vsockUdsPath;
				if (!vsockUdsPath) {
					throw new Error(
						"health check requires vsock — handle.meta.vsockUdsPath is missing",
					);
				}

				if (workload.health.http_get) {
					const port = workload.health.http_get.port
						?? (await this.runtime.getEndpoint(handle)).ports[0]!;
					log(`Health check: http via guest agent [GET localhost:${port}${workload.health.http_get.path}]...`);
				} else {
					log(`Health check: exec via guest agent [${workload.health.exec!.command.join(" ")}]...`);
				}

				vsockHandle = createVsockCheck(vsockUdsPath, 52, log);
				const check = vsockHandle.check;

				const config: HealthConfig = {
					interval: intervalMs,
					unhealthyThreshold: workload.health.unhealthy_threshold,
					timeoutMs: Math.max(
						intervalMs * workload.health.unhealthy_threshold * 2,
						this.defaultHealthTimeoutMs,
					),
				};

				log(`Health check: timeout ${Math.round(config.timeoutMs / 1000)}s, interval ${Math.round(intervalMs / 1000)}s, threshold ${workload.health.unhealthy_threshold}`);
				await this.healthChecker(check, config, log);
				log("Health check passed.");
			}

			log("Taking snapshot...");
			// Take the snapshot
			const ref = await this.runtime.snapshot(handle);

			const goldenRef: SnapshotRef = {
				...ref,
				type: "golden",
				workloadId,
				nodeId: this.nodeId,
			};

			// Upsert — delete any existing golden for this workload+node, then insert
			this.db
				.delete(snapshots)
				.where(
					and(
						eq(snapshots.workloadId, workloadId),
						eq(snapshots.nodeId, this.nodeId),
						eq(snapshots.type, "golden"),
					),
				)
				.run();

			const sizeBytes = this.computeSnapshotSize(goldenRef);

			this.db
				.insert(snapshots)
				.values({
					snapshotId: goldenRef.id,
					type: "golden",
					status: "creating",
					instanceId,
					workloadId,
					nodeId: this.nodeId,
					vmstatePath: goldenRef.paths.vmstate,
					memoryPath: goldenRef.paths.memory,
					sizeBytes,
					runtimeMeta: goldenRef.runtimeMeta as Record<string, unknown>,
					createdAt: new Date(),
				})
				.run();

			applySnapshotTransition(this.db, goldenRef.id, "creating", "created");

			log("Destroying bootstrap VM...");
			// Destroy the bootstrap VM
			await this.runtime.destroy(handle);

			return goldenRef;
		} catch (err) {
			// Dump the guest console log on failure for debugging
			const consolePath = handle.meta?.consolePath;
			if (consolePath) {
				try {
					const consoleOutput = readFileSync(consolePath, "utf-8");
					const lines = consoleOutput.split("\n").filter(Boolean);
					const tail = lines.slice(-100);
					log("--- Guest console (last 100 lines) ---");
					for (const line of tail) {
						log(line);
					}
					log("--- End guest console ---");
				} catch {
					// Console log may not exist
				}
			}

			// Clean up the bootstrap VM on any failure
			try {
				await this.runtime.destroy(handle);
			} catch {
				// Ignore cleanup errors
			}
			throw err;
		} finally {
			vsockHandle?.cleanup();
		}
	}

	/**
	 * Looks up the golden snapshot for a workload+node combination.
	 * Returns `null` if no golden snapshot exists or if runtime metadata
	 * is missing/incompatible.
	 */
	getGolden(workloadId: WorkloadId, nodeId: NodeId): SnapshotRef | null {
		const row = this.db
			.select()
			.from(snapshots)
			.where(
				and(
					eq(snapshots.workloadId, workloadId),
					eq(snapshots.nodeId, nodeId),
					eq(snapshots.type, "golden"),
					eq(snapshots.status, "ready"),
				),
			)
			.get();

		if (!row) return null;

		return snapshotRefFrom(row);
	}

	/** Fast boolean check for whether a golden snapshot exists. */
	goldenExists(workloadId: WorkloadId, nodeId: NodeId): boolean {
		return this.getGolden(workloadId, nodeId) !== null;
	}

	/** Computes total size of snapshot files (vmstate + memory). */
	private computeSnapshotSize(ref: SnapshotRef): number {
		let total = 0;
		try {
			total += statSync(ref.paths.vmstate).size;
		} catch {
			// File may not exist yet or be inaccessible
		}
		if (ref.paths.memory) {
			try {
				total += statSync(ref.paths.memory).size;
			} catch {
				// File may not exist yet or be inaccessible
			}
		}
		return total;
	}
}
