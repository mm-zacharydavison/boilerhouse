import { eq } from "drizzle-orm";
import type { WorkloadId } from "@boilerhouse/core";
import type { DrizzleDb } from "@boilerhouse/db";
import { workloads } from "@boilerhouse/db";
import type { PoolManager } from "@boilerhouse/domain";
import type {
  BoilerhousePool,
  BoilerhousePoolStatus,
} from "@boilerhouse/runtime-kubernetes";

export interface PoolControllerDeps {
  db: DrizzleDb;
  poolManager: PoolManager;
}

/**
 * Reconciles a BoilerhousePool CRD.
 * Looks up the referenced workload, compares pool depth to target size,
 * and replenishes if needed.
 */
export async function reconcilePool(
  crd: BoilerhousePool,
  deps: PoolControllerDeps,
): Promise<BoilerhousePoolStatus> {
  const workloadName = crd.spec.workloadRef;
  const targetSize = crd.spec.size;

  try {
    // 1. Look up referenced workload by name
    const workloadRow = deps.db
      .select()
      .from(workloads)
      .where(eq(workloads.name, workloadName))
      .get();

    if (!workloadRow) {
      return {
        phase: "Error",
        ready: 0,
        warming: 0,
      };
    }

    if (workloadRow.status !== "ready" && workloadRow.status !== "created") {
      return {
        phase: "Degraded",
        ready: 0,
        warming: 0,
      };
    }

    const workloadId = workloadRow.workloadId as WorkloadId;

    // 2. Check current pool depth
    const currentDepth = deps.poolManager.getPoolDepth(workloadId);

    // 3. Replenish if under target
    if (currentDepth < targetSize) {
      await deps.poolManager.replenish(workloadId);
    }

    const readyCount = deps.poolManager.getPoolDepth(workloadId);

    return {
      phase: "Healthy",
      ready: readyCount,
      warming: 0,
    };
  } catch (err) {
    return {
      phase: "Error",
      ready: 0,
      warming: 0,
    };
  }
}
