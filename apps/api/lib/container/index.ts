// Re-export runtime types from @boilerhouse/core
export type {
  RuntimeContainerInfo,
  ContainerRuntime,
  ContainerSecurityConfig,
  ContainerSpec,
  EnvVar,
  NetworkConfig,
  RuntimeContainerId,
  RuntimeContainerStatus,
  TmpfsMount,
  VolumeMount,
} from '@boilerhouse/core'
export { DEFAULT_NETWORK_CONFIG, DEFAULT_SECURITY_CONFIG } from '@boilerhouse/core'

// Container manager (uses runtime interface)
export { ContainerManager, type ContainerManagerConfig } from './manager'

// Container pool (uses manager)
export { ContainerPool, type ContainerPoolConfig, type PoolStats } from './pool'

// Idle reaper (filesystem-based TTL expiry)
export { IdleReaper, type IdleReaperDeps } from './idle-reaper'

// Shared claim flow
export { claimContainer, type ClaimContainerDeps, type ClaimResult } from './claim'

// Shared release flow
export { releaseContainer, type ReleaseContainerDeps } from './release'
