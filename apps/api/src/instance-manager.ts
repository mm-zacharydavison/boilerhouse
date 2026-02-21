import { eq } from "drizzle-orm";
import type {
	Runtime,
	InstanceHandle,
	InstanceId,
	WorkloadId,
	NodeId,
	TenantId,
	SnapshotRef,
	Workload,
} from "@boilerhouse/core";
import { generateInstanceId } from "@boilerhouse/core";
import type { DrizzleDb, ActivityLog } from "@boilerhouse/db";
import { instances, snapshots, tenants } from "@boilerhouse/db";
import { InstanceActor, SnapshotActor, TenantActor } from "./actors";

export class SnapshotNotFoundError extends Error {
	constructor(snapshotId: string) {
		super(`Snapshot not found: ${snapshotId}`);
		this.name = "SnapshotNotFoundError";
	}
}

export class InstanceManager {
	constructor(
		private readonly runtime: Runtime,
		private readonly db: DrizzleDb,
		private readonly activityLog: ActivityLog,
		private readonly nodeId: NodeId,
	) {}

	async create(
		workloadId: WorkloadId,
		workload: Workload,
	): Promise<InstanceHandle> {
		const instanceId = generateInstanceId();

		this.db
			.insert(instances)
			.values({
				instanceId,
				workloadId,
				nodeId: this.nodeId,
				status: "starting",
				createdAt: new Date(),
			})
			.run();

		try {
			const handle = await this.runtime.create(workload, instanceId);
			await this.runtime.start(handle);

			const actor = new InstanceActor(this.db, instanceId);
			actor.send("started");

			this.activityLog.log({
				event: "instance.created",
				instanceId,
				workloadId,
				nodeId: this.nodeId,
			});

			return handle;
		} catch (err) {
			this.db
				.delete(instances)
				.where(eq(instances.instanceId, instanceId))
				.run();
			throw err;
		}
	}

	async destroy(instanceId: InstanceId): Promise<void> {
		const row = this.db
			.select()
			.from(instances)
			.where(eq(instances.instanceId, instanceId))
			.get();

		if (!row) return;

		const handle: InstanceHandle = {
			instanceId,
			running: row.status === "active",
		};

		const actor = new InstanceActor(this.db, instanceId);
		actor.send("destroy");

		await this.runtime.destroy(handle);

		actor.send("destroyed");

		if (row.tenantId) {
			const tenantRow = this.db
				.select({ status: tenants.status })
				.from(tenants)
				.where(eq(tenants.tenantId, row.tenantId))
				.get();

			if (tenantRow?.status === "active") {
				const tenantActor = new TenantActor(this.db, row.tenantId);
				tenantActor.send("release");
				tenantActor.send("destroyed");

				this.db
					.update(tenants)
					.set({ instanceId: null })
					.where(eq(tenants.tenantId, row.tenantId))
					.run();
			}
		}

		this.activityLog.log({
			event: "instance.destroyed",
			instanceId,
			nodeId: this.nodeId,
			workloadId: row.workloadId,
			tenantId: row.tenantId,
		});
	}

	async hibernate(instanceId: InstanceId): Promise<SnapshotRef> {
		const row = this.db
			.select()
			.from(instances)
			.where(eq(instances.instanceId, instanceId))
			.get();

		if (!row) {
			throw new Error(`Instance not found: ${instanceId}`);
		}

		const actor = new InstanceActor(this.db, instanceId);
		actor.validate("hibernate");

		const handle: InstanceHandle = {
			instanceId,
			running: row.status === "active",
		};

		let ref: SnapshotRef;
		try {
			ref = await this.runtime.snapshot(handle);
		} catch (err) {
			await this.destroy(instanceId);
			throw err;
		}

		// Use the instance row's workloadId/nodeId for FK integrity
		const correctedRef: SnapshotRef = {
			...ref,
			workloadId: row.workloadId,
			nodeId: this.nodeId,
		};

		this.db
			.insert(snapshots)
			.values({
				snapshotId: correctedRef.id,
				type: correctedRef.type,
				status: "creating",
				instanceId,
				tenantId: row.tenantId,
				workloadId: row.workloadId,
				nodeId: this.nodeId,
				vmstatePath: correctedRef.paths.vmstate,
				memoryPath: correctedRef.paths.memory,
				sizeBytes: 0,
				runtimeMeta: correctedRef.runtimeMeta as Record<string, unknown>,
				createdAt: new Date(),
			})
			.run();

		const snapActor = new SnapshotActor(this.db, correctedRef.id);
		snapActor.send("created");

		await this.runtime.destroy(handle);

		actor.send("hibernate");

		if (row.tenantId) {
			// Delete the previous tenant snapshot (keep only the latest)
			const tenantRow = this.db
				.select({ lastSnapshotId: tenants.lastSnapshotId, status: tenants.status })
				.from(tenants)
				.where(eq(tenants.tenantId, row.tenantId))
				.get();

			if (tenantRow?.lastSnapshotId) {
				this.db
					.delete(snapshots)
					.where(eq(snapshots.snapshotId, tenantRow.lastSnapshotId))
					.run();
			}

			this.db
				.update(tenants)
				.set({ lastSnapshotId: correctedRef.id })
				.where(eq(tenants.tenantId, row.tenantId))
				.run();

			// If tenant is still "active", this hibernate was called directly
			// (not through the tenant release flow). Transition the tenant to
			// "released" and clear its instanceId so it can be re-claimed.
			if (tenantRow?.status === "active") {
				const tenantActor = new TenantActor(this.db, row.tenantId);
				tenantActor.send("release");
				tenantActor.send("hibernated");

				this.db
					.update(tenants)
					.set({ instanceId: null })
					.where(eq(tenants.tenantId, row.tenantId))
					.run();
			}
		}

		this.activityLog.log({
			event: "instance.hibernated",
			instanceId,
			nodeId: this.nodeId,
			workloadId: row.workloadId,
			tenantId: row.tenantId,
			metadata: { snapshotId: correctedRef.id },
		});

		return correctedRef;
	}

	async restoreFromSnapshot(
		ref: SnapshotRef,
		tenantId: TenantId,
	): Promise<InstanceHandle> {
		// Verify the snapshot exists in the DB
		const snapshotRow = this.db
			.select()
			.from(snapshots)
			.where(eq(snapshots.snapshotId, ref.id))
			.get();

		if (!snapshotRow) {
			throw new SnapshotNotFoundError(ref.id);
		}

		const instanceId = generateInstanceId();

		this.db
			.insert(instances)
			.values({
				instanceId,
				workloadId: snapshotRow.workloadId,
				nodeId: this.nodeId,
				tenantId,
				status: "starting",
				createdAt: new Date(),
			})
			.run();

		const handle = await this.runtime.restore(ref, instanceId);

		const actor = new InstanceActor(this.db, instanceId);
		actor.send("started");

		this.activityLog.log({
			event: "instance.restored",
			instanceId,
			nodeId: this.nodeId,
			workloadId: snapshotRow.workloadId,
			tenantId,
			metadata: {
				snapshotType: ref.type,
				snapshotId: ref.id,
			},
		});

		return handle;
	}
}
