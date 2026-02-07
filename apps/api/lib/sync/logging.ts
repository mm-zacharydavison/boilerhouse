/**
 * Sync Result Logging
 *
 * Shared helper for reducing sync results, checking errors, and logging
 * to the activity log. Deduplicates the pattern used in claim, release,
 * and manual sync endpoints.
 */

import type { TenantId } from '@boilerhouse/core'
import { type ActivityLog, logSyncCompleted, logSyncFailed } from '../activity'
import type { SyncResult } from './rclone'

/**
 * Log sync results to the activity log.
 * Reduces results to total bytes, checks for errors, and calls the
 * appropriate activity log method.
 */
export function logSyncResults(
  tenantId: TenantId,
  results: SyncResult[],
  activityLog: ActivityLog,
): { hasErrors: boolean } {
  const totalBytes = results.reduce((sum, r) => sum + (r.bytesTransferred ?? 0), 0)
  const hasErrors = results.some((r) => !r.success)

  if (hasErrors) {
    const errors = results.filter((r) => !r.success).flatMap((r) => r.errors ?? [])
    logSyncFailed(tenantId, errors.join('; '), activityLog)
  } else {
    logSyncCompleted(tenantId, totalBytes, activityLog)
  }

  return { hasErrors }
}
