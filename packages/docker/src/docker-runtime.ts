/**
 * Docker Runtime Implementation
 *
 * Implements ContainerRuntime using dockerode.
 */

import type {
  ContainerInfo,
  ContainerRuntime,
  ContainerSpec,
  RuntimeContainerId,
  RuntimeContainerStatus,
} from '@boilerhouse/core'
import Docker from 'dockerode'

export interface DockerRuntimeConfig {
  /**
   * Path to the Docker socket for local connections.
   * @example '/var/run/docker.sock'
   * @example '/home/user/.docker/desktop/docker.sock'
   */
  socketPath?: string

  /**
   * Docker host for remote connections. When set, uses TCP instead of socket.
   * @example 'localhost'
   * @example '192.168.1.100'
   * @example 'docker.example.com'
   */
  host?: string

  /**
   * Docker port for remote connections. Only used when `host` is set.
   * @default 2375
   */
  port?: number
}

export class DockerRuntime implements ContainerRuntime {
  readonly name = 'docker'
  private docker: Docker

  constructor(config?: DockerRuntimeConfig) {
    if (config?.host) {
      this.docker = new Docker({ host: config.host, port: config.port ?? 2375 })
    } else {
      this.docker = new Docker({ socketPath: config?.socketPath ?? '/var/run/docker.sock' })
    }
  }

  async createContainer(spec: ContainerSpec): Promise<ContainerInfo> {
    const container = await this.docker.createContainer({
      name: spec.name,
      Image: spec.image,
      Cmd: spec.args,
      Entrypoint: spec.command,
      Env: spec.env.map((e: { name: string; value: string }) => `${e.name}=${e.value}`),
      Labels: spec.labels,
      // Health check configuration
      Healthcheck: spec.healthCheck
        ? {
            Test: ['CMD', ...spec.healthCheck.command],
            Interval: spec.healthCheck.intervalMs * 1_000_000, // Convert ms to nanoseconds
            Timeout: spec.healthCheck.timeoutMs * 1_000_000,
            Retries: spec.healthCheck.retries,
            StartPeriod: (spec.healthCheck.startPeriodMs ?? 0) * 1_000_000,
          }
        : undefined,
      HostConfig: {
        // Security options
        ReadonlyRootfs: spec.security.readOnlyRootFilesystem,
        CapDrop: spec.security.dropAllCapabilities ? ['ALL'] : [],
        CapAdd: spec.security.addCapabilities,
        SecurityOpt: spec.security.noNewPrivileges ? ['no-new-privileges:true'] : [],
        UsernsMode: spec.security.runAsNonRoot ? '' : undefined,

        // Resource limits
        NanoCpus: spec.resources.cpus * 1e9,
        Memory: spec.resources.memory * 1024 * 1024,

        // Tmpfs mounts
        Tmpfs: Object.fromEntries(
          spec.tmpfs.map((t: { target: string; sizeBytes: number; mode?: number }) => [
            t.target,
            `size=${Math.floor(t.sizeBytes / (1024 * 1024))}m${t.mode ? `,mode=${t.mode}` : ''}`,
          ]),
        ),

        // Volume mounts
        Binds: spec.volumes.map(
          (v: { source: string; target: string; readOnly: boolean }) =>
            `${v.source}:${v.target}:${v.readOnly ? 'ro' : 'rw'}`,
        ),

        // Network
        NetworkMode: spec.network.network,
        Dns: spec.network.dnsServers,

        // Don't auto-restart, we manage lifecycle
        RestartPolicy: { Name: 'no' },
      },
      // Run as specific user if set
      User: spec.security.runAsUser?.toString(),
    })

    await container.start()

    const info = await container.inspect()
    return this.toContainerInfo(info)
  }

  async stopContainer(id: RuntimeContainerId, timeoutSeconds = 10): Promise<void> {
    try {
      const container = this.docker.getContainer(id)
      await container.stop({ t: timeoutSeconds })
    } catch (err) {
      if (!this.isNotRunningError(err)) {
        throw err
      }
    }
  }

  async removeContainer(id: RuntimeContainerId): Promise<void> {
    try {
      const container = this.docker.getContainer(id)
      await container.remove({ force: true })
    } catch (err) {
      if (!this.isNotFoundError(err)) {
        throw err
      }
    }
  }

  async destroyContainer(id: RuntimeContainerId, timeoutSeconds = 10): Promise<void> {
    await this.stopContainer(id, timeoutSeconds)
    await this.removeContainer(id)
  }

  async getContainer(id: RuntimeContainerId): Promise<ContainerInfo | null> {
    try {
      const container = this.docker.getContainer(id)
      const info = await container.inspect()
      return this.toContainerInfo(info)
    } catch (err) {
      if (this.isNotFoundError(err)) {
        return null
      }
      throw err
    }
  }

  async isHealthy(id: RuntimeContainerId): Promise<boolean> {
    try {
      const container = this.docker.getContainer(id)
      const info = await container.inspect()
      return info.State.Running === true
    } catch {
      return false
    }
  }

  async listContainers(labels: Record<string, string>): Promise<ContainerInfo[]> {
    const filters: Record<string, string[]> = {
      label: Object.entries(labels).map(([k, v]) => `${k}=${v}`),
    }

    const containers = await this.docker.listContainers({
      all: true,
      filters: JSON.stringify(filters),
    })

    return Promise.all(
      containers.map(async (c) => {
        const container = this.docker.getContainer(c.Id)
        const info = await container.inspect()
        return this.toContainerInfo(info)
      }),
    )
  }

  async exec(
    id: RuntimeContainerId,
    command: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const container = this.docker.getContainer(id)

    const exec = await container.exec({
      Cmd: command,
      AttachStdout: true,
      AttachStderr: true,
    })

    const stream = await exec.start({ hijack: true, stdin: false })

    return new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''

      stream.on('data', (chunk: Buffer) => {
        // Docker multiplexes stdout/stderr with an 8-byte header
        // First byte: stream type (1 = stdout, 2 = stderr)
        // Bytes 5-8: payload length (big endian)
        let offset = 0
        while (offset < chunk.length) {
          if (offset + 8 > chunk.length) break

          const streamType = chunk[offset]
          const length = chunk.readUInt32BE(offset + 4)

          if (offset + 8 + length > chunk.length) break

          const payload = chunk.slice(offset + 8, offset + 8 + length).toString()

          if (streamType === 1) {
            stdout += payload
          } else if (streamType === 2) {
            stderr += payload
          }

          offset += 8 + length
        }
      })

      stream.on('end', async () => {
        try {
          const inspectResult = await exec.inspect()
          resolve({
            exitCode: inspectResult.ExitCode ?? 0,
            stdout,
            stderr,
          })
        } catch (err) {
          reject(err)
        }
      })

      stream.on('error', reject)
    })
  }

  private toContainerInfo(info: Docker.ContainerInspectInfo): ContainerInfo {
    return {
      id: info.Id,
      name: info.Name.replace(/^\//, ''),
      status: this.toStatus(info.State),
      createdAt: new Date(info.Created),
      startedAt: info.State.StartedAt ? new Date(info.State.StartedAt) : undefined,
      labels: info.Config.Labels ?? {},
    }
  }

  private toStatus(state: Docker.ContainerInspectInfo['State']): RuntimeContainerStatus {
    if (state.Running) return 'running'
    if (state.Paused) return 'stopped'
    if (state.Restarting) return 'creating'
    if (state.Dead || state.OOMKilled) return 'failed'
    if (state.Status === 'created') return 'creating'
    if (state.Status === 'exited') return 'stopped'
    return 'unknown'
  }

  private isNotFoundError(err: unknown): boolean {
    return (
      err instanceof Error &&
      (err.message.includes('no such container') || err.message.includes('404'))
    )
  }

  private isNotRunningError(err: unknown): boolean {
    return err instanceof Error && err.message.includes('is not running')
  }
}
