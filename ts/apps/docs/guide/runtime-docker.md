# Docker Runtime

The Docker runtime manages containers via the Docker daemon socket. It's the default runtime and the simplest way to run Boilerhouse on a single host.

## Setup

### Requirements

- Docker Engine 20.10+ (or Docker Desktop)
- Docker daemon accessible via Unix socket

### Configuration

Set `RUNTIME_TYPE=docker` (this is the default):

```bash
export RUNTIME_TYPE=docker
```

The Docker socket path is auto-detected:
- Linux: `/var/run/docker.sock`
- macOS (Docker Desktop): `~/.docker/run/docker.sock`

To override:

```bash
export DOCKER_SOCKET=/path/to/docker.sock
```

## How It Works

When Boilerhouse creates an instance on the Docker runtime, it:

1. **Resolves the image** — pulls from registry (`image.ref`) or builds from Dockerfile (`image.dockerfile`)
2. **Creates the container** with:
   - Resource limits (CPU, memory)
   - Network mode based on `network.access`
   - Port mappings from `network.expose`
   - Overlay directories as bind mounts
   - Environment variables from `entrypoint.env`
   - Entrypoint override from `entrypoint.cmd`
3. **Starts the container**
4. **Runs health checks** until the container is healthy
5. **Returns the endpoint** (host + mapped ports)

### Networking Modes

The Docker runtime maps `network.access` to Docker network modes:

| Access Mode | Docker Configuration |
|-------------|---------------------|
| `none` | `NetworkMode: "none"`, no port bindings |
| `unrestricted` | Bridge network, metadata server blocked |
| `restricted` | Bridge network + Envoy sidecar proxy |

For `restricted` access, an Envoy sidecar container is co-located to enforce domain allowlists and inject credentials. See [Networking & Security](./networking).

### Port Mapping

Exposed ports use the `host_range` to find an available host port:

```typescript
expose: [{ guest: 8080, host_range: [30000, 30099] }]
```

Docker binds the container's port 8080 to an available port in the 30000-30099 range on the host.

### Overlay Bind Mounts

Each overlay directory gets a temporary host directory bind-mounted into the container:

```
/tmp/boilerhouse/<instanceId>/workspace → /workspace (in container)
/tmp/boilerhouse/<instanceId>/home     → /home/user (in container)
```

This allows Boilerhouse to extract and inject overlay data without needing to exec into the container.

## Security

The Docker runtime applies several hardening measures:

### Capability Dropping

All Linux capabilities are dropped, then only necessary ones are added back:

```
CAP_DROP: ALL
CAP_ADD: (none by default)
```

### Seccomp Profiles

Apply a custom seccomp profile to restrict system calls:

```bash
export SECCOMP_PROFILE_PATH=/path/to/seccomp.json
```

This is passed directly to Docker's `--security-opt seccomp=` option.

### Privilege Escalation

- `no_new_privileges: true` — prevents child processes from gaining privileges
- Containers do not run as root when the image supports it

### Metadata Server Blocking

For `unrestricted` and `restricted` modes, iptables rules block access to the cloud metadata endpoint (`169.254.169.254`) to prevent credential leakage on cloud hosts.

## Image Management

### Registry Images

```typescript
image: { ref: "alpine:latest" }
```

The Docker runtime pulls images from the configured registry. Standard Docker auth (`.docker/config.json`) applies.

### Dockerfile Builds

```typescript
image: { dockerfile: "my-agent/Dockerfile" }
```

The Dockerfile path is relative to the workloads directory. The Docker runtime builds the image locally with the workloads directory as the build context.

### Image Caching

Docker's standard image layer caching applies. Pre-pulled base images speed up cold boots.

## Container Lifecycle

| Operation | Docker Implementation |
|-----------|----------------------|
| `create` | `docker create` with all config |
| `start` | `docker start` |
| `destroy` | `docker rm -f` |
| `exec` | `docker exec` |
| `logs` | `docker logs --tail N` |
| `pause` | `docker pause` |
| `unpause` | `docker unpause` |
| `injectArchive` | Pipe tar into bind mount |
| `extractOverlay` | Tar from bind mount |

## Endpoint Host

By default, the endpoint host is `127.0.0.1`. If running Boilerhouse inside Docker (docker-in-docker), set:

```bash
export ENDPOINT_HOST=host.docker.internal
```
