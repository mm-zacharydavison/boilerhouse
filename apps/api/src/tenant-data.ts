import { mkdirSync, copyFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { TenantId, WorkloadId } from "@boilerhouse/core";
import type { DrizzleDb } from "@boilerhouse/db";
import { tenants } from "@boilerhouse/db";

export class TenantDataStore {
	constructor(
		private readonly storagePath: string,
		private readonly db: DrizzleDb,
	) {}

	/**
	 * Copies an overlay archive into tenant storage and records the reference
	 * on the tenant row.
	 */
	saveOverlay(tenantId: TenantId, workloadId: WorkloadId, overlayPath: string): void {
		const destDir = join(this.storagePath, tenantId, workloadId);
		mkdirSync(destDir, { recursive: true });

		const destPath = join(destDir, "overlay.tar.gz");
		copyFileSync(overlayPath, destPath);

		this.db
			.update(tenants)
			.set({ dataOverlayRef: destPath })
			.where(eq(tenants.tenantId, tenantId))
			.run();
	}

	/**
	 * Writes overlay data directly into tenant storage from a buffer
	 * (e.g. tar archive extracted from a running container).
	 */
	saveOverlayBuffer(tenantId: TenantId, workloadId: WorkloadId, data: Buffer): void {
		const destDir = join(this.storagePath, tenantId, workloadId);
		mkdirSync(destDir, { recursive: true });

		const destPath = join(destDir, "overlay.tar.gz");
		writeFileSync(destPath, data);

		this.db
			.update(tenants)
			.set({ dataOverlayRef: destPath })
			.where(eq(tenants.tenantId, tenantId))
			.run();
	}

	/**
	 * Returns the path to the stored overlay for this tenant+workload,
	 * or `null` if no overlay exists.
	 */
	restoreOverlay(tenantId: TenantId): string | null {
		const row = this.db
			.select({ dataOverlayRef: tenants.dataOverlayRef })
			.from(tenants)
			.where(eq(tenants.tenantId, tenantId))
			.get();

		if (!row?.dataOverlayRef) return null;

		if (!existsSync(row.dataOverlayRef)) return null;

		return row.dataOverlayRef;
	}
}
