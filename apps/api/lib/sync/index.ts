/**
 * Sync Module
 *
 * Provides rclone-based state synchronization between containers and remote storage.
 * Sync configuration is defined in WorkloadSpec.sync - there is no separate sync registry.
 */

// Sink adapters for different storage backends
export { type SinkAdapter, SinkAdapterRegistry, defaultSinkAdapterRegistry } from './sink-adapter'
export { S3SinkAdapter } from './sink-adapters'

// Rclone executor for sync operations
export {
  RcloneSyncExecutor,
  type RcloneSyncExecutorConfig,
  type SyncResult,
} from './rclone'

// Status tracker for monitoring sync state
export {
  SyncStatusTracker,
  type SyncError,
  type SyncStatusEntry,
} from './status'

// Coordinator for orchestrating sync lifecycle
export {
  SyncCoordinator,
  type SyncCoordinatorConfig,
} from './coordinator'

// Shared sync result logging
export { logSyncResults } from './logging'
