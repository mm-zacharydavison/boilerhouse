/**
 * Typed rclone error detection.
 *
 * rclone doesn't use structured error codes — all errors come as stderr/stdout text.
 * These type guards match against known rclone error patterns so detection logic
 * lives in one place and can be reused across the sync pipeline.
 */

import type { SyncResult } from './rclone'

/**
 * Discriminated union of known rclone error types.
 */
export type RcloneError =
  | { type: 'source_directory_not_found'; bucket: string; path: string }
  | { type: 'bisync_resync_required' }

/**
 * Match: the remote source directory does not exist.
 *
 * rclone emits this when syncing from an S3 prefix that has no objects.
 * Pattern (from rclone fs/sync errors):
 *   `S3 bucket <bucket> path <path>: error reading source root directory: directory not found`
 */
const SOURCE_DIR_NOT_FOUND = /S3 bucket (\S+) path (\S+): error reading source root directory: directory not found/

export function isSourceDirectoryNotFound(result: SyncResult): result is SyncResult & { success: false } {
  if (result.success) return false
  return result.errors?.some((e) => SOURCE_DIR_NOT_FOUND.test(e)) ?? false
}

/**
 * Match: bisync state is corrupted and needs --resync to recover.
 *
 * rclone emits this when bisync tracking files are missing or inconsistent.
 * Pattern (from rclone cmd/bisync):
 *   `Bisync aborted. Must run --resync to recover.`
 */
const BISYNC_RESYNC_REQUIRED = /Bisync aborted\. Must run --resync to recover/

export function isBisyncResyncRequired(result: SyncResult): result is SyncResult & { success: false } {
  if (result.success) return false
  return result.errors?.some((e) => BISYNC_RESYNC_REQUIRED.test(e)) ?? false
}

/**
 * Attempt to parse a structured RcloneError from a failed SyncResult.
 * Returns the first matching error type, or undefined if unrecognized.
 */
export function parseRcloneError(result: SyncResult): RcloneError | undefined {
  if (result.success) return undefined

  for (const error of result.errors ?? []) {
    const dirMatch = SOURCE_DIR_NOT_FOUND.exec(error)
    if (dirMatch) {
      return { type: 'source_directory_not_found', bucket: dirMatch[1], path: dirMatch[2] }
    }

    if (BISYNC_RESYNC_REQUIRED.test(error)) {
      return { type: 'bisync_resync_required' }
    }
  }

  return undefined
}
