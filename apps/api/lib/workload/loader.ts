import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { WorkloadId, WorkloadSpec } from '@boilerhouse/core'
import {
  type ParseResult,
  type ValidationError,
  camelToSnakeDeep,
  formatDuration,
  formatMemory,
  safeParseWorkloadSpec,
} from '@boilerhouse/core'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

/**
 * Interpolate environment variables in a string
 * Supports ${VAR} syntax, only replaces if the env var exists in process.env
 * This preserves runtime variables like ${tenantId} that should be interpolated later
 */
function interpolateEnvVars(content: string): string {
  return content.replace(/\$\{([^}]+)\}/g, (match, varName) => {
    // Only replace if the env var exists, otherwise keep the original ${VAR} syntax
    if (varName in process.env) {
      return process.env[varName] ?? ''
    }
    return match
  })
}

/**
 * Workload validation error
 */
export class WorkloadValidationError extends Error {
  constructor(
    public readonly file: string,
    public readonly errors: ValidationError[],
  ) {
    const errorList = errors.map((e) => `  - ${e.path}: ${e.message}`).join('\n')
    super(`Invalid workload specification in ${file}:\n${errorList}`)
    this.name = 'WorkloadValidationError'
  }
}

/**
 * Resolve relative seed paths to absolute and validate they exist.
 * Mutates the spec in place for simplicity (called right after parse).
 */
function resolveSeedPaths(spec: WorkloadSpec, yamlDir: string, filePath: string): void {
  const volumeKeys = ['state', 'secrets', 'comm'] as const
  for (const key of volumeKeys) {
    const vol = spec.volumes[key]
    if (!vol?.seed) continue
    const resolved = isAbsolute(vol.seed) ? vol.seed : resolve(yamlDir, vol.seed)
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      throw new WorkloadValidationError(filePath, [
        { path: `volumes.${key}.seed`, message: `Seed directory does not exist: ${resolved}` },
      ])
    }
    vol.seed = resolved
  }

  if (spec.volumes.custom) {
    for (const custom of spec.volumes.custom) {
      if (!custom.seed) continue
      const resolved = isAbsolute(custom.seed) ? custom.seed : resolve(yamlDir, custom.seed)
      if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
        throw new WorkloadValidationError(filePath, [
          {
            path: `volumes.custom.${custom.name}.seed`,
            message: `Seed directory does not exist: ${resolved}`,
          },
        ])
      }
      custom.seed = resolved
    }
  }
}

/**
 * Load and validate a single workload YAML file
 * Environment variables in ${VAR} format are interpolated from process.env
 */
export function loadWorkloadFile(filePath: string): WorkloadSpec {
  const content = readFileSync(filePath, 'utf-8')
  const interpolated = interpolateEnvVars(content)
  const rawYaml = parseYaml(interpolated)

  const result = safeParseWorkloadSpec(rawYaml)
  if (!result.success) {
    throw new WorkloadValidationError(filePath, result.errors)
  }

  resolveSeedPaths(result.data, dirname(filePath), filePath)

  return result.data
}

/**
 * Load all workload YAML files from a directory
 */
export function loadWorkloadsFromDir(dirPath: string): Map<WorkloadId, WorkloadSpec> {
  const workloads = new Map<WorkloadId, WorkloadSpec>()

  let files: string[]
  try {
    files = readdirSync(dirPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return workloads
    }
    throw error
  }

  for (const file of files) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue
    const filePath = join(dirPath, file)
    if (!statSync(filePath).isFile()) continue

    const spec = loadWorkloadFile(filePath)
    workloads.set(spec.id, spec)
  }

  return workloads
}

/**
 * Convert a WorkloadSpec to YAML-compatible format with human-readable duration/memory strings
 * Converts camelCase TypeScript fields back to snake_case for YAML output
 */
function workloadSpecToYaml(spec: WorkloadSpec): Record<string, unknown> {
  // First convert camelCase to snake_case for YAML compatibility
  const yaml = camelToSnakeDeep(spec) as Record<string, unknown>

  // Convert milliseconds back to duration strings for readability
  const healthcheck = yaml.healthcheck as Record<string, unknown> | undefined
  if (healthcheck) {
    if (typeof healthcheck.interval === 'number') {
      healthcheck.interval = formatDuration(healthcheck.interval as number)
    }
    if (typeof healthcheck.timeout === 'number') {
      healthcheck.timeout = formatDuration(healthcheck.timeout as number)
    }
    if (typeof healthcheck.start_period === 'number') {
      healthcheck.start_period = formatDuration(healthcheck.start_period as number)
    }
  }

  const pool = yaml.pool as Record<string, unknown> | undefined
  if (pool?.idle_timeout && typeof pool.idle_timeout === 'number') {
    pool.idle_timeout = formatDuration(pool.idle_timeout as number)
  }

  const sync = yaml.sync as Record<string, unknown> | undefined
  const policy = sync?.policy as Record<string, unknown> | undefined
  if (policy?.interval && typeof policy.interval === 'number') {
    policy.interval = formatDuration(policy.interval as number)
  }

  // Convert memory values back to strings in deploy.resources.limits
  const deploy = yaml.deploy as Record<string, unknown> | undefined
  const resources = deploy?.resources as Record<string, unknown> | undefined
  const limits = resources?.limits as Record<string, unknown> | undefined
  if (limits) {
    if (typeof limits.memory === 'number') {
      limits.memory = formatMemory(limits.memory as number)
    }
  }

  return yaml
}

/**
 * Save a workload spec to a YAML file
 */
export function saveWorkloadFile(filePath: string, spec: WorkloadSpec): void {
  const yaml = workloadSpecToYaml(spec)
  const content = stringifyYaml(yaml, { indent: 2 })
  writeFileSync(filePath, content, 'utf-8')
}

/**
 * Event emitted when workloads change
 */
export type WorkloadChangeEvent =
  | { type: 'added'; workload: WorkloadSpec }
  | { type: 'updated'; workload: WorkloadSpec; previous: WorkloadSpec }
  | { type: 'removed'; workloadId: WorkloadId }

/**
 * Workload change listener
 */
export type WorkloadChangeListener = (event: WorkloadChangeEvent) => void

/**
 * File-backed workload registry with optional file watching
 */
export class WorkloadRegistry {
  private workloads: Map<WorkloadId, WorkloadSpec> = new Map()
  private filePaths: Map<WorkloadId, string> = new Map()
  private listeners: Set<WorkloadChangeListener> = new Set()
  private watcher: ReturnType<typeof watch> | null = null

  constructor(private readonly dirPath: string) {}

  /**
   * Load all workloads from the directory
   */
  load(): void {
    const previous = new Map(this.workloads)
    this.workloads.clear()
    this.filePaths.clear()

    let files: string[]
    try {
      files = readdirSync(this.dirPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return
      }
      throw error
    }

    for (const file of files) {
      if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue
      const filePath = join(this.dirPath, file)
      if (!statSync(filePath).isFile()) continue

      try {
        const spec = loadWorkloadFile(filePath)
        this.workloads.set(spec.id, spec)
        this.filePaths.set(spec.id, filePath)

        const prev = previous.get(spec.id)
        if (prev) {
          this.emit({ type: 'updated', workload: spec, previous: prev })
        } else {
          this.emit({ type: 'added', workload: spec })
        }
      } catch (error) {
        console.error(`Failed to load workload from ${filePath}:`, error)
      }
    }

    for (const [id] of previous) {
      if (!this.workloads.has(id)) {
        this.emit({ type: 'removed', workloadId: id })
      }
    }
  }

  /**
   * Get a workload by ID
   */
  get(id: WorkloadId): WorkloadSpec | undefined {
    return this.workloads.get(id)
  }

  /**
   * Check if a workload exists
   */
  has(id: WorkloadId): boolean {
    return this.workloads.has(id)
  }

  /**
   * List all workloads
   */
  list(): WorkloadSpec[] {
    return Array.from(this.workloads.values())
  }

  /**
   * Get all workload IDs
   */
  ids(): WorkloadId[] {
    return Array.from(this.workloads.keys())
  }

  /**
   * Number of registered workloads
   */
  get size(): number {
    return this.workloads.size
  }

  /**
   * Register a new workload (saves to file)
   */
  register(spec: WorkloadSpec): void {
    const filePath = join(this.dirPath, `${spec.id}.yaml`)
    saveWorkloadFile(filePath, spec)
    this.workloads.set(spec.id, spec)
    this.filePaths.set(spec.id, filePath)
    this.emit({ type: 'added', workload: spec })
  }

  /**
   * Update an existing workload (saves to file)
   */
  update(spec: WorkloadSpec): void {
    const previous = this.workloads.get(spec.id)
    if (!previous) {
      throw new Error(`Workload not found: ${spec.id}`)
    }

    const filePath = this.filePaths.get(spec.id) ?? join(this.dirPath, `${spec.id}.yaml`)
    saveWorkloadFile(filePath, spec)
    this.workloads.set(spec.id, spec)
    this.emit({ type: 'updated', workload: spec, previous })
  }

  /**
   * Remove a workload (deletes file)
   */
  remove(id: WorkloadId): void {
    const filePath = this.filePaths.get(id)
    if (!filePath) {
      throw new Error(`Workload not found: ${id}`)
    }

    unlinkSync(filePath)
    this.workloads.delete(id)
    this.filePaths.delete(id)
    this.emit({ type: 'removed', workloadId: id })
  }

  /**
   * Add a change listener
   */
  onChange(listener: WorkloadChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Start watching for file changes
   */
  startWatching(): void {
    if (this.watcher) return

    this.watcher = watch(this.dirPath, { persistent: false }, (eventType, filename) => {
      if (!filename) return
      if (!filename.endsWith('.yaml') && !filename.endsWith('.yml')) return

      // Debounce by reloading all files
      setTimeout(() => this.load(), 100)
    })
  }

  /**
   * Stop watching for file changes
   */
  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
  }

  private emit(event: WorkloadChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('Workload change listener error:', error)
      }
    }
  }
}

/**
 * Create and initialize a workload registry from a directory
 */
export function createWorkloadRegistry(dirPath: string): WorkloadRegistry {
  const registry = new WorkloadRegistry(dirPath)
  registry.load()
  return registry
}
