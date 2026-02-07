/**
 * Re-export runtime types from @boilerhouse/core for convenience.
 * The actual implementations are in @boilerhouse/docker (and future @boilerhouse/kubernetes).
 */

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
