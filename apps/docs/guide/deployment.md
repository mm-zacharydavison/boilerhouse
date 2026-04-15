# Deployment

This guide covers production deployment options for Boilerhouse. For a quick local setup, see the [Quick Start](./quick-start.md).

## Single Binary

Boilerhouse compiles to a single self-contained binary via `bun build --compile`:

```bash
bun run build
# Output: ./boilerhouse
```

Run the API server directly:

```bash
BOILERHOUSE_SECRET_KEY=$(openssl rand -hex 32) ./boilerhouse api start
```

The binary includes all dependencies and requires no external runtime. It runs on Linux (amd64 and arm64).

## systemd

Install Boilerhouse as a systemd service for automatic startup and process supervision. Requires root:

```bash
sudo ./boilerhouse api install --data-dir /var/lib/boilerhouse
```

This command:

1. Generates `/etc/boilerhouse/api.env` with a random `BOILERHOUSE_SECRET_KEY` (if the file does not already exist)
2. Writes a systemd unit file to `/etc/systemd/system/boilerhouse-api.service`
3. Runs `systemctl daemon-reload`, `enable`, and `start`

Manage the service with standard systemd commands:

```bash
sudo systemctl status boilerhouse-api
sudo systemctl restart boilerhouse-api
sudo journalctl -u boilerhouse-api -f
```

Edit `/etc/boilerhouse/api.env` to configure environment variables, then restart the service to apply changes. See [Configuration](./configuration.md) for all available variables.

## Docker

Run Boilerhouse itself in a Docker container, managing workload containers on the host via a Docker socket mount:

```bash
docker run -d \
  --name boilerhouse \
  -p 3000:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v boilerhouse-data:/data \
  -e BOILERHOUSE_SECRET_KEY=$(openssl rand -hex 32) \
  -e RUNTIME_TYPE=docker \
  -e DB_PATH=/data/boilerhouse.db \
  -e STORAGE_PATH=/data \
  boilerhouse:latest api start
```

::: warning
Mounting the Docker socket gives the container full control over the host Docker daemon. This is required for Boilerhouse to manage workload containers but has security implications. In production, consider running Boilerhouse directly on the host or using the Kubernetes runtime instead.
:::

## Kubernetes Operator

For Kubernetes deployments, Boilerhouse provides an operator that manages workloads as custom resources:

1. Apply CRDs to the cluster:
   ```bash
   kubectl apply -f crds/
   ```

2. Deploy the operator with appropriate RBAC (service account, cluster role, and binding)

3. Create custom resources to define your workloads:
   ```yaml
   apiVersion: boilerhouse.dev/v1alpha1
   kind: BoilerhouseWorkload
   metadata:
     name: my-agent
   spec:
     # ... workload configuration
   ```

4. The operator reconciles `BoilerhouseWorkload`, `BoilerhousePool`, and `BoilerhouseTrigger` resources into running instances

See [Kubernetes Runtime](./runtime-kubernetes.md) for detailed setup instructions.

## Production Checklist

Before going live, verify the following:

- [ ] **Secret key** -- Set `BOILERHOUSE_SECRET_KEY` to a securely generated 32-byte hex value. This key encrypts tenant data at rest; losing it means losing access to encrypted overlays.

- [ ] **API authentication** -- Set `BOILERHOUSE_API_KEY` to protect the API. Without it, all endpoints are unauthenticated.

- [ ] **Snapshot storage** -- Configure S3 (`S3_ENABLED=true` with bucket credentials) for durable snapshot storage. Without S3, snapshots are stored locally and lost if the disk fails.

- [ ] **Monitoring** -- Set up Prometheus to scrape `METRICS_PORT` (default 9464). Configure log aggregation for the Boilerhouse process. Optionally set `OTEL_EXPORTER_OTLP_ENDPOINT` for distributed tracing.

- [ ] **Instance limits** -- Set `MAX_INSTANCES` appropriate for your node capacity. The default is 100.

- [ ] **CORS** -- Configure `CORS_ORIGIN` if exposing the API to browser clients.

- [ ] **Bind address** -- Set `LISTEN_HOST=0.0.0.0` if the server should accept connections on all interfaces (the default binds to localhost only).

- [ ] **Database backups** -- Back up the SQLite database file (`DB_PATH`) regularly. It contains all workload definitions, tenant state, and audit logs.

- [ ] **Process supervision** -- Use a process manager (systemd) or orchestrator (Kubernetes) to ensure Boilerhouse restarts automatically on failure.

::: tip
For a complete list of all environment variables, see the [Configuration](./configuration.md) reference.
:::
