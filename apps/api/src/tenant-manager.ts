import { eq, and } from "drizzle-orm";
import type {
	InstanceId,
	InstanceHandle,
	WorkloadId,
	NodeId,
	TenantId,
	SnapshotId,
	SnapshotRef,
	Endpoint,
	TenantStatus,
	Workload,
} from "@boilerhouse/core";
import type { DrizzleDb, ActivityLog } from "@boilerhouse/db";
import { instances, snapshots, tenants, workloads, snapshotRefFrom } from "@boilerhouse/db";
import type { Logger } from "@boilerhouse/o11y";
import { applyTenantTransition } from "./transitions";
import { instanceHandleFrom } from "./instance-manager";
import type { InstanceManager } from "./instance-manager";
import type { SnapshotManager } from "./snapshot-manager";
import type { TenantDataStore } from "./tenant-data";
import type { IdleMonitor } from "./idle-monitor";
import type { WatchDirsPoller } from "./watch-dirs-poller";
import type { EventBus } from "./event-bus";

export type ClaimSource = "existing" | "snapshot" | "cold+data" | "golden" | "cold";

export interface ClaimResult {
	tenantId: TenantId;
	instanceId: InstanceId;
	endpoint: Endpoint | null;
	source: ClaimSource;
	latencyMs: number;
}

export class NoGoldenSnapshotError extends Error {
	constructor(workloadId: WorkloadId, nodeId: NodeId) {
		super(
			`No golden snapshot found for workload ${workloadId} on node ${nodeId}`,
		);
		this.name = "NoGoldenSnapshotError";
	}
}

export class TenantManager {
	/** Per-tenant+workload lock to prevent duplicate claims from concurrent requests. */
	private readonly inflightClaims = new Map<string, Promise<ClaimResult>>();
	/**
	 * Per-snapshot mutex for CRIU restores.
	 * CRIU cannot restore the same checkpoint archive concurrently —
	 * concurrent restores from the same golden snapshot must be serialized.
	 */
	private readonly restoreLocks = new Map<string, Promise<void>>();

	constructor(
		private readonly instanceManager: InstanceManager,
		private readonly snapshotManager: SnapshotManager,
		private readonly db: DrizzleDb,
		private readonly activityLog: ActivityLog,
		private readonly nodeId: NodeId,
		private readonly tenantDataStore: TenantDataStore,
		private readonly idleMonitor?: IdleMonitor,
		private readonly log?: Logger,
		private readonly eventBus?: EventBus,
		private readonly watchDirsPoller?: WatchDirsPoller,
	) {}

	/**
	 * Claims an instance for the given tenant.
	 *
	 * When the runtime supports golden snapshots, follows the restore hierarchy:
	 * 1. Existing active instance
	 * 2. Tenant snapshot (hot restore)
	 * 3. Golden + data overlay (cold restore with data)
	 * 4. Golden snapshot (fresh)
	 *
	 * When golden snapshots are not supported:
	 * 1. Existing active instance
	 * 2. Tenant snapshot (restore)
	 * 3. Cold boot from workload definition
	 */
	async claim(tenantId: TenantId, workloadId: WorkloadId): Promise<ClaimResult> {
		const key = `${tenantId}:${workloadId}`;
		const inflight = this.inflightClaims.get(key);
		if (inflight) return inflight;

		const promise = this.claimInner(tenantId, workloadId).finally(() => {
			this.inflightClaims.delete(key);
		});
		this.inflightClaims.set(key, promise);
		return promise;
	}

	private async claimInner(tenantId: TenantId, workloadId: WorkloadId): Promise<ClaimResult> {
		const start = performance.now();

		// 1. Check for existing active, starting, or restoring instance for this tenant+workload
		const existingInstance = this.db
			.select()
			.from(instances)
			.where(
				and(
					eq(instances.tenantId, tenantId),
					eq(instances.workloadId, workloadId),
				),
			)
			.all()
			.find((r) => r.status === "active" || r.status === "starting" || r.status === "restoring");

		if (existingInstance) {
			const handle = instanceHandleFrom(existingInstance.instanceId, existingInstance.status);
			const endpoint = await this.safeGetEndpoint(handle);

			return {
				tenantId,
				instanceId: existingInstance.instanceId,
				endpoint,
				source: "existing",
				latencyMs: performance.now() - start,
			};
		}

		// 2. Check for tenant snapshot
		const tenantRow = this.db
			.select()
			.from(tenants)
			.where(and(eq(tenants.tenantId, tenantId), eq(tenants.workloadId, workloadId)))
			.get();

		// Register the tenant as "claiming" immediately so it's visible in the dashboard / API
		this.markClaiming(tenantId, workloadId, tenantRow);

		try {
			if (tenantRow?.lastSnapshotId) {
				const snapshotRef = this.getSnapshotRef(tenantRow.lastSnapshotId);
				if (snapshotRef) {
					this.log?.info({ tenantId, workloadId, source: "snapshot", snapshotId: snapshotRef.id }, "Claiming via tenant snapshot");
					return await this.restoreAndClaim(snapshotRef, tenantId, workloadId, "snapshot", start);
				}
			}

			if (this.snapshotManager.capabilities.goldenSnapshots) {
				return await this.claimViaGolden(tenantId, workloadId, tenantRow, start);
			}

			return await this.claimViaColdBoot(tenantId, workloadId, tenantRow, start);
		} catch (err) {
			// Restore/create failed — revert tenant to idle
			this.revertClaiming(tenantId, workloadId);
			throw err;
		}
	}

	/** Golden snapshot claim path (steps 3–4): overlay restore or fresh golden. */
	private async claimViaGolden(
		tenantId: TenantId,
		workloadId: WorkloadId,
		tenantRow: { tenantId: TenantId } | undefined,
		start: number,
	): Promise<ClaimResult> {
		// 3. Check for data overlay (cold+data path)
		const overlayPath = tenantRow
			? this.tenantDataStore.restoreOverlay(tenantId, workloadId)
			: null;

		if (overlayPath) {
			const goldenRef = this.snapshotManager.getGolden(workloadId, this.nodeId);
			if (!goldenRef) {
				throw new NoGoldenSnapshotError(workloadId, this.nodeId);
			}

			this.log?.info({ tenantId, workloadId, source: "cold+data", snapshotId: goldenRef.id }, "Claiming via golden + data overlay");
			const result = await this.restoreAndClaim(goldenRef, tenantId, workloadId, "cold+data", start);
			await this.instanceManager.injectOverlay(result.instanceId, overlayPath);
			return result;
		}

		// 4. Fresh from golden
		const goldenRef = this.snapshotManager.getGolden(workloadId, this.nodeId);
		if (!goldenRef) {
			throw new NoGoldenSnapshotError(workloadId, this.nodeId);
		}

		this.log?.info({ tenantId, workloadId, source: "golden", snapshotId: goldenRef.id }, "Claiming via golden snapshot");
		return this.restoreAndClaim(goldenRef, tenantId, workloadId, "golden", start);
	}

	/** Cold boot claim path: create a fresh instance from the workload definition. */
	private async claimViaColdBoot(
		tenantId: TenantId,
		workloadId: WorkloadId,
		tenantRow: { tenantId: TenantId } | undefined,
		start: number,
	): Promise<ClaimResult> {
		const workloadRow = this.db
			.select()
			.from(workloads)
			.where(eq(workloads.workloadId, workloadId))
			.get();

		if (!workloadRow) {
			throw new Error(`Workload not found: ${workloadId}`);
		}

		// Check for data overlay (cold boot + data path)
		const overlayPath = tenantRow
			? this.tenantDataStore.restoreOverlay(tenantId, workloadId)
			: null;

		const source: ClaimSource = overlayPath ? "cold+data" : "cold";
		this.log?.info({ tenantId, workloadId, source }, `Claiming via ${source}`);

		const handle = await this.instanceManager.create(
			workloadId,
			workloadRow.config as Workload,
			tenantId,
		);

		this.completeClaim(tenantId, workloadId, handle.instanceId);
		this.updateInstanceClaimed(handle.instanceId);

		if (overlayPath) {
			await this.instanceManager.injectOverlay(handle.instanceId, overlayPath);
		}

		const endpoint = await this.safeGetEndpoint(handle);
		const latencyMs = performance.now() - start;

		this.logClaim(tenantId, handle.instanceId, workloadId, source);
		this.startIdleWatch(handle.instanceId, workloadId);

		return {
			tenantId,
			instanceId: handle.instanceId,
			endpoint,
			source,
			latencyMs,
		};
	}

	/**
	 * Releases a tenant's instance according to the workload's idle policy.
	 *
	 * When `idle.action` is `"hibernate"`, the runtime snapshots the instance
	 * (CRIU checkpoint on Podman, overlay tar on Kubernetes) and the tenant
	 * can be restored from it on re-claim. When `"destroy"`, the instance is
	 * removed entirely.
	 *
	 * No-op if the tenant has no active instance.
	 */
	async release(tenantId: TenantId, workloadId: WorkloadId): Promise<void> {
		const tenantRow = this.db
			.select()
			.from(tenants)
			.where(and(eq(tenants.tenantId, tenantId), eq(tenants.workloadId, workloadId)))
			.get();

		if (!tenantRow?.instanceId) return;

		const instanceId = tenantRow.instanceId;

		const tenantStatus = tenantRow.status as TenantStatus;
		applyTenantTransition(this.db, tenantId, workloadId, tenantStatus, "release");

		if (this.idleMonitor) {
			this.idleMonitor.unwatch(instanceId);
		}

		if (this.watchDirsPoller) {
			this.watchDirsPoller.stopPolling(instanceId);
		}

		// Look up the workload config to determine idle action
		const workloadRow = this.db
			.select()
			.from(workloads)
			.where(eq(workloads.workloadId, tenantRow.workloadId))
			.get();

		const idleAction = workloadRow?.config?.idle?.action ?? "hibernate";

		// Save overlay data from the running container before hibernate/destroy
		const workloadConfig = workloadRow?.config as Workload | undefined;
		const overlayDirs = workloadConfig?.filesystem?.overlay_dirs;
		if (overlayDirs?.length) {
			const overlayData = await this.instanceManager.extractOverlay(instanceId, overlayDirs);
			if (overlayData) {
				this.tenantDataStore.saveOverlayBuffer(tenantId, tenantRow.workloadId, overlayData);
				this.log?.info({ tenantId, workloadId: tenantRow.workloadId }, "Saved overlay data for tenant");
			}
		}

		if (idleAction === "hibernate") {
			await this.instanceManager.hibernate(instanceId);
			applyTenantTransition(this.db, tenantId, workloadId, "releasing", "hibernated");
		} else {
			await this.instanceManager.destroy(instanceId);
			applyTenantTransition(this.db, tenantId, workloadId, "releasing", "destroyed");
		}

		// Clear instanceId on tenant row (lastSnapshotId is preserved by hibernate)
		this.db
			.update(tenants)
			.set({ instanceId: null })
			.where(and(eq(tenants.tenantId, tenantId), eq(tenants.workloadId, workloadId)))
			.run();

		this.activityLog.log({
			event: "tenant.released",
			tenantId,
			instanceId,
			workloadId: tenantRow.workloadId,
			nodeId: this.nodeId,
		});
	}

	private async restoreAndClaim(
		ref: SnapshotRef,
		tenantId: TenantId,
		workloadId: WorkloadId,
		source: ClaimSource,
		start: number,
	): Promise<ClaimResult> {
		// Create the instance row immediately so it's visible in the UI
		// while waiting for the CRIU restore mutex.
		const prepared = this.instanceManager.prepareRestore(ref, tenantId);

		// Link the instance to the tenant row right away (still in "claiming" status)
		this.db
			.update(tenants)
			.set({ instanceId: prepared.instanceId })
			.where(and(eq(tenants.tenantId, tenantId), eq(tenants.workloadId, workloadId)))
			.run();

		this.eventBus?.emit({
			type: "tenant.claiming",
			tenantId,
			workloadId,
			source,
			snapshotId: ref.id,
		});

		let handle;
		try {
			handle = await this.serializedRestore(ref.id, () =>
				this.instanceManager.executeRestore(ref, prepared.instanceId, prepared.workloadId, tenantId),
			);
		} catch (err) {
			this.log?.error(
				{ tenantId, workloadId, source, snapshotId: ref.id, err },
				"Restore failed during claim",
			);
			throw err;
		}

		this.completeClaim(tenantId, workloadId, handle.instanceId);
		this.updateInstanceClaimed(handle.instanceId);

		const endpoint = await this.safeGetEndpoint(handle);
		const latencyMs = performance.now() - start;

		this.log?.info(
			{ tenantId, instanceId: handle.instanceId, workloadId, source, endpoint, latencyMs: Math.round(latencyMs) },
			"Claim completed",
		);

		this.logClaim(tenantId, handle.instanceId, workloadId, source);
		this.startIdleWatch(handle.instanceId, workloadId);

		return {
			tenantId,
			instanceId: handle.instanceId,
			endpoint,
			source,
			latencyMs,
		};
	}

	/**
	 * Serializes restore operations that share the same snapshot.
	 * CRIU cannot restore the same checkpoint archive concurrently, and
	 * needs a brief cooldown between restores for overlay cleanup.
	 */
	private async serializedRestore<T>(snapshotId: string, fn: () => Promise<T>): Promise<T> {
		const tail = this.restoreLocks.get(snapshotId) ?? Promise.resolve();

		let resolve!: () => void;
		const next = new Promise<void>((r) => { resolve = r; });
		this.restoreLocks.set(snapshotId, next);

		// Wait for all prior restores of this snapshot to finish
		await tail.catch(() => {});

		try {
			return await fn();
		} catch (err) {
			// Brief cooldown after failure — CRIU overlay cleanup is async
			await new Promise((r) => setTimeout(r, 500));
			throw err;
		} finally {
			resolve();
			if (this.restoreLocks.get(snapshotId) === next) {
				this.restoreLocks.delete(snapshotId);
			}
		}
	}

	/** Returns the endpoint, or null for containers with no exposed ports. */
	private async safeGetEndpoint(handle: InstanceHandle): Promise<Endpoint | null> {
		const endpoint = await this.instanceManager.getEndpoint(handle);
		if (endpoint.ports.length === 0) return null;
		return endpoint;
	}

	private getSnapshotRef(snapshotId: SnapshotId): SnapshotRef | null {
		const row = this.db
			.select()
			.from(snapshots)
			.where(eq(snapshots.snapshotId, snapshotId))
			.get();

		if (!row) return null;

		return snapshotRefFrom(row);
	}

	/**
	 * Registers the tenant as "claiming" before the restore/create begins.
	 * Inserts a new row if none exists, or transitions an existing row.
	 */
	private markClaiming(
		tenantId: TenantId,
		workloadId: WorkloadId,
		existing: { tenantId: TenantId; status?: string | null } | undefined,
	): void {
		if (existing) {
			applyTenantTransition(this.db, tenantId, workloadId, existing.status as TenantStatus, "claim");
		} else {
			this.db
				.insert(tenants)
				.values({
					tenantId,
					workloadId,
					status: "claiming" as TenantStatus,
					createdAt: new Date(),
				})
				.run();
		}
	}

	/**
	 * Reverts the tenant from "claiming" back to "idle" when a claim fails.
	 */
	private revertClaiming(tenantId: TenantId, workloadId: WorkloadId): void {
		try {
			applyTenantTransition(this.db, tenantId, workloadId, "claiming", "claim_failed");
			this.db
				.update(tenants)
				.set({ instanceId: null })
				.where(and(eq(tenants.tenantId, tenantId), eq(tenants.workloadId, workloadId)))
				.run();
		} catch {
			// Best-effort — tenant may have been modified by concurrent operations
		}
	}

	/**
	 * Completes a claim: sets the instance and transitions claiming → active.
	 */
	private completeClaim(
		tenantId: TenantId,
		workloadId: WorkloadId,
		instanceId: InstanceId,
	): void {
		applyTenantTransition(this.db, tenantId, workloadId, "claiming", "claimed");

		this.db
			.update(tenants)
			.set({ instanceId, lastActivity: new Date() })
			.where(and(eq(tenants.tenantId, tenantId), eq(tenants.workloadId, workloadId)))
			.run();
	}

	/** Sets claimedAt and lastActivity on the instance row. */
	private updateInstanceClaimed(instanceId: InstanceId): void {
		const now = new Date();
		this.db
			.update(instances)
			.set({ claimedAt: now, lastActivity: now })
			.where(eq(instances.instanceId, instanceId))
			.run();
	}

	/** Logs a tenant.claimed event. */
	private logClaim(
		tenantId: TenantId,
		instanceId: InstanceId,
		workloadId: WorkloadId,
		source: ClaimSource,
	): void {
		this.activityLog.log({
			event: "tenant.claimed",
			tenantId,
			instanceId,
			workloadId,
			nodeId: this.nodeId,
			metadata: { source },
		});
	}

	/** Starts idle monitoring for a newly claimed instance, if an IdleMonitor is configured. */
	private startIdleWatch(instanceId: InstanceId, workloadId: WorkloadId): void {
		if (!this.idleMonitor) return;

		const workloadRow = this.db
			.select()
			.from(workloads)
			.where(eq(workloads.workloadId, workloadId))
			.get();

		const idle = workloadRow?.config?.idle;
		this.idleMonitor.watch(instanceId, {
			timeoutMs: ((idle?.timeout_seconds as number | undefined) ?? 300) * 1000,
			action: idle?.action ?? "hibernate",
		});

		const watchDirs = idle?.watch_dirs as string[] | undefined;
		if (watchDirs?.length && this.watchDirsPoller) {
			this.watchDirsPoller.startPolling(instanceId, watchDirs);
		}
	}
}
