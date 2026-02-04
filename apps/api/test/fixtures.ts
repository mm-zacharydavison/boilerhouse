/**
 * Shared test fixtures using Faker.js
 *
 * Provides factory functions for creating test data across all tests.
 */

import { mock } from 'bun:test'
import type {
  ContainerId,
  PoolContainer,
  PoolId,
  S3SinkConfig,
  SyncId,
  SyncMapping,
  SyncPolicy,
  SyncSpec,
  TenantId,
  WorkloadId,
  WorkloadSpec,
} from '@boilerhouse/core'
import { faker } from '@faker-js/faker'

// =============================================================================
// ID Generators
// =============================================================================

export function createTenantId(): TenantId {
  return `tenant-${faker.string.alphanumeric(8)}` as TenantId
}

export function createContainerId(): ContainerId {
  return `${faker.string.alphanumeric(8)}-${faker.string.alphanumeric(8)}` as ContainerId
}

export function createPoolId(): PoolId {
  return `pool-${faker.string.alphanumeric(6)}` as PoolId
}

export function createSyncId(): SyncId {
  return `sync-${faker.string.alphanumeric(6)}` as SyncId
}

export function createWorkloadId(): WorkloadId {
  return `workload-${faker.string.alphanumeric(6)}` as WorkloadId
}

// =============================================================================
// Workload Fixtures
// =============================================================================

export function createWorkloadSpec(overrides?: Partial<WorkloadSpec>): WorkloadSpec {
  return {
    id: createWorkloadId(),
    name: faker.commerce.productName(),
    image: `${faker.internet.domainWord()}/${faker.internet.domainWord()}:${faker.system.semver()}`,
    volumes: {
      state: { containerPath: '/state', mode: 'rw' },
      secrets: { containerPath: '/secrets', mode: 'ro' },
      comm: { containerPath: '/comm', mode: 'rw' },
    },
    environment: {
      STATE_DIR: '/state',
      SOCKET_PATH: '/comm/app.sock',
    },
    healthCheck: {
      command: ['true'],
      intervalMs: 30000,
      timeoutMs: 5000,
      retries: 3,
    },
    ...overrides,
  }
}

// =============================================================================
// Container Fixtures
// =============================================================================

export function createPoolContainer(overrides?: Partial<PoolContainer>): PoolContainer {
  const containerId = createContainerId()
  return {
    containerId,
    tenantId: createTenantId(),
    poolId: createPoolId(),
    socketPath: `/var/run/boilerhouse/${containerId}/app.sock`,
    stateDir: `/var/lib/boilerhouse/states/${containerId}`,
    secretsDir: `/var/lib/boilerhouse/secrets/${containerId}`,
    lastActivity: faker.date.recent(),
    status: 'assigned',
    ...overrides,
  }
}

// =============================================================================
// Sync Fixtures
// =============================================================================

export function createS3SinkConfig(overrides?: Partial<S3SinkConfig>): S3SinkConfig {
  return {
    type: 's3',
    bucket: faker.string.alphanumeric(12).toLowerCase(),
    region: faker.helpers.arrayElement(['us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1']),
    prefix: 'tenants/${tenantId}/',
    accessKeyId: faker.string.alphanumeric(20).toUpperCase(),
    secretAccessKey: faker.string.alphanumeric(40),
    ...overrides,
  }
}

export function createSyncMapping(overrides?: Partial<SyncMapping>): SyncMapping {
  return {
    containerPath: `/${faker.system.directoryPath().split('/').pop()}`,
    sinkPath: `${faker.system.directoryPath().split('/').pop()}/`,
    direction: faker.helpers.arrayElement(['upload', 'download', 'bidirectional']),
    mode: faker.helpers.arrayElement(['sync', 'copy']),
    ...overrides,
  }
}

export function createSyncPolicy(overrides?: Partial<SyncPolicy>): SyncPolicy {
  return {
    onClaim: faker.datatype.boolean(),
    onRelease: faker.datatype.boolean(),
    allowManualTrigger: faker.datatype.boolean(),
    intervalMs: faker.helpers.arrayElement([undefined, 30000, 60000, 300000]),
    ...overrides,
  }
}

export function createSyncSpec(overrides?: Partial<SyncSpec>): SyncSpec {
  return {
    id: createSyncId(),
    poolId: createPoolId(),
    mappings: [createSyncMapping()],
    sink: createS3SinkConfig(),
    policy: createSyncPolicy(),
    ...overrides,
  }
}

// =============================================================================
// Mock Factories
// =============================================================================

/**
 * Mock result for sync operations.
 */
export interface MockSyncResult {
  success: boolean
  bytesTransferred?: number
  filesTransferred?: number
  errors?: string[]
  duration: number
}

export function createMockSyncResult(overrides?: Partial<MockSyncResult>): MockSyncResult {
  return {
    success: true,
    bytesTransferred: faker.number.int({ min: 0, max: 1024 * 1024 * 10 }),
    filesTransferred: faker.number.int({ min: 0, max: 100 }),
    duration: faker.number.int({ min: 50, max: 5000 }),
    ...overrides,
  }
}

/**
 * Create a mock RcloneSyncExecutor.
 * Import the actual type from the sync module when using.
 */
export function createMockRcloneExecutor() {
  const successResult = createMockSyncResult()
  return {
    sync: mock(async () => successResult),
    upload: mock(async () => successResult),
    download: mock(async () => successResult),
    isAvailable: mock(async () => true),
    getVersion: mock(async () => faker.system.semver()),
  }
}

/**
 * Create a mock ContainerRuntime.
 * Import the actual type from the container module when using.
 */
export function createMockContainerRuntime() {
  let containerCount = 0

  return {
    name: 'mock',

    createContainer: mock(async (spec: { name: string; labels: Record<string, string> }) => {
      containerCount++
      return {
        id: `mock-container-${containerCount}`,
        name: spec.name,
        status: 'running' as const,
        createdAt: faker.date.recent(),
        startedAt: faker.date.recent(),
        labels: spec.labels,
      }
    }),

    stopContainer: mock(async () => {}),
    removeContainer: mock(async () => {}),
    destroyContainer: mock(async () => {}),

    getContainer: mock(async (id: string) => ({
      id,
      name: `container-${id}`,
      status: 'running' as const,
      createdAt: faker.date.recent(),
      startedAt: faker.date.recent(),
      labels: {},
    })),

    isHealthy: mock(async () => true),
    listContainers: mock(async () => []),
    exec: mock(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
  }
}

// =============================================================================
// Seeding
// =============================================================================

/**
 * Set a fixed seed for reproducible test data.
 * Call this in beforeAll() or beforeEach() if you need deterministic tests.
 */
export function seedFaker(seed: number): void {
  faker.seed(seed)
}

/**
 * Reset faker to use random seed.
 */
export function resetFakerSeed(): void {
  faker.seed()
}
