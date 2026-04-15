# Docker Runtime

The Docker runtime runs each Boilerhouse instance as a Docker container on the host machine. It is the default runtime and the simplest to set up for local development.

## Setup

The Docker runtime requires a running Docker daemon. Any of the following will work:

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- [colima](https://github.com/abiosoft/colima) (macOS/Linux)
- Native `dockerd` (Linux)

Verify that Docker is available:

```bash
docker ps
```

Set the runtime type in your environment:

```bash
export RUNTIME_TYPE=docker
```

If your Docker socket is not at the default path (`/var/run/docker.sock`), set `DOCKER_SOCKET`:

```bash
export DOCKER_SOCKET=/path/to/docker.sock
```

## How It Works

### Container Creation

When a workload instance is created, Boilerhouse calls the Docker API to create and start a container. The container spec includes:

- **Image**: resolved from `image.ref` (pre-built) or built from `image.dockerfile` at registration time
- **Resource limits**: CPU quota and memory limit mapped from `resources.vcpus` and `resources.memory_mb`
- **Labels**: `boilerhouse.managed`, `boilerhouse.role`, `boilerhouse.workload`, and `boilerhouse.version` for identification and cleanup
- **Entrypoint**: `cmd`, `args`, `workdir`, and `env` from the workload definition
- **Network mode**: `bridge` for `restricted`/`unrestricted` access, `none` for fully isolated workloads

### Port Exposure

Workloads declare ports via `network.expose`:

```typescript
network: {
  expose: [{ guest: 8080, host_range: [30000, 31000] }],
}
```

The `guest` port is the port inside the container. Docker assigns an available host port automatically (using `HostPort: "0"`). The assigned port is returned in the claim response endpoint. If no ports are explicitly exposed and the network access mode is not `"none"`, port 8080 is exposed by default.

### Overlay Injection

Tenant filesystem state is stored as tar archives. Before an instance starts, Boilerhouse injects the tenant's overlay by either:

- Extracting the archive directly into host directories that back bind-mounted overlay paths
- Using `putArchive` on the Docker API to push the tar into the container layer

Overlay directories declared in `filesystem.overlay_dirs` are backed by host bind mounts, so data persists across `exec` calls and is visible before the entrypoint runs.

### Health Checks

Boilerhouse performs its own health checking (not Docker's `HEALTHCHECK`):

- **HTTP probe**: sends `GET` requests to the configured path and port inside the container
- **Exec probe**: runs a command inside the container via `docker exec`

The health check interval, timeout, and unhealthy threshold are all configurable in the workload definition.

## Security

### Capability Hardening

All containers are created with hardened Linux capabilities:

- All capabilities are dropped (`CapDrop: ["ALL"]`)
- Only a minimal set required for operation is added back
- `no-new-privileges` is always set, preventing privilege escalation via setuid binaries

### Seccomp Profiles

Optionally restrict the set of system calls a container can make:

```bash
export SECCOMP_PROFILE_PATH=/path/to/seccomp-profile.json
```

When set, the seccomp profile is loaded and applied to every container. This is useful for sandboxing untrusted code.

### Network Isolation

Network mode is determined by the workload's `network.access` setting:

| Access Level | Docker Network Mode | Effect |
|---|---|---|
| `"none"` | `none` | No network access at all |
| `"restricted"` | `bridge` | Outbound filtered by Envoy sidecar |
| `"unrestricted"` | `bridge` | Full outbound access |

For workloads with `restricted` or `unrestricted` access, Boilerhouse blocks access to the cloud metadata server (`169.254.169.254`) via an iptables rule injected at container start.

### Envoy Sidecar Proxy

When a workload has network credentials or a `restricted` access mode, an Envoy sidecar container is created alongside the workload container. The sidecar:

- Shares the workload container's network namespace
- Intercepts all outbound HTTP/HTTPS traffic via `HTTP_PROXY` environment variables
- Enforces the domain allowlist
- Injects credential headers on matching domains via MITM TLS
- Manages its own CA certificate, which is bind-mounted into the workload container

See [Networking](./networking.md) for full details on network access control and credential injection.

## Image Management

### Dockerfile-based Workloads

When a workload specifies `image.dockerfile`, the Docker runtime builds the image at registration time:

1. The Dockerfile is resolved relative to the workloads directory
2. `docker build` runs with the workload's build context
3. Build logs are captured in the `build_logs` table
4. The resulting image is tagged and cached locally

### Pre-built Images

When a workload specifies `image.ref`, the runtime pulls the image from the registry on first use. Docker's built-in layer caching avoids redundant pulls.

### Container Stats

The Docker runtime exposes per-container resource statistics (CPU fraction, memory usage, memory limit) via the Docker stats API. These feed into Prometheus metrics when observability is enabled.

## Overlay Extraction

When an instance is released or hibernated, Boilerhouse extracts the overlay filesystem:

1. For bind-mounted overlay directories, the host directory contents are archived directly
2. The archive is compressed with gzip and optionally encrypted
3. The archive is stored in the configured [storage backend](./storage.md)

The next time the tenant claims an instance, their overlay is injected into the new container before it starts.

## Related Pages

- [Networking](./networking.md) -- network access modes, credential injection, Envoy sidecar
- [Storage](./storage.md) -- overlay and snapshot storage backends
- [Runtime: Kubernetes](./runtime-kubernetes.md) -- deploying workloads to Kubernetes instead
- [Configuration](./configuration.md) -- environment variables reference
