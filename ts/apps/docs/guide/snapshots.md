# Snapshots & Hibernation

Boilerhouse can hibernate instances — saving their filesystem state and restoring it on the next claim. This enables cost-effective idle management without losing tenant work.

## Hibernation

When a tenant's Pod goes idle or is released, the operator hibernates it:

1. **Extract** the overlay directories as a compressed tar archive via a helper Pod with the snapshots PVC mounted
2. **Save** the archive at `/snapshots/<tenantId>/<workload>.tar.gz`
3. **Destroy** the tenant Pod

The tenant's state is now persisted on the snapshots PVC. The Pod is gone, consuming zero resources beyond the saved archive.

### When Hibernation Triggers

Hibernation triggers in three ways:

- **Manual release** — `POST /api/v1/tenants/:id/release` (or `kubectl delete boilerhouseclaim ...`) extracts overlays and hibernates
- **Idle timeout** — when the operator's idle monitor fires (after `idle.timeoutSeconds` of inactivity), the claim is automatically released and hibernated
- **Destroy API** — `POST /api/v1/instances/:id/destroy` skips overlay extraction and just deletes the Pod

The idle action is configured per-workload:

```yaml
idle:
  timeoutSeconds: 300   # 5 minutes of inactivity
  action: hibernate     # or "destroy" to discard state
```

## Restoration

When a hibernated tenant claims the same workload again, their state is restored:

1. A new Pod is created (from pool or cold boot)
2. The overlay archive is retrieved from the snapshots PVC
3. A short init step extracts the archive into the Pod's overlay volumes
4. The container is ready with the tenant's previous state

This happens transparently — the claim response indicates the source:

```json
{
  "source": "pool+data"
}
```

## Overlay Directories

The directories that get persisted are declared in the workload config:

```yaml
filesystem:
  overlayDirs:
    - /workspace
    - /home/user
```

The operator creates an `emptyDir` volume for each overlay directory and mounts it into the Pod. Only these directories are extracted and saved. System directories, installed packages, and other container state are not preserved — they come from the base image on each boot.

Choose overlay directories that contain tenant-specific data:
- `/workspace` — project files
- `/home/user` — user configuration, shell history
- `/root/.openclaw` — agent state

### What Gets Saved

Extraction runs `tar czf` over the declared directories. Everything in those directories is included — files, symlinks, permissions, timestamps.

### What Doesn't Get Saved

- Running processes (they're killed on hibernation)
- In-memory state
- Network connections
- Files outside `overlayDirs`
- Installed packages (use the base image for these)

## Snapshot Helper Pod

All overlay access goes through a single long-lived Pod named `boilerhouse-snapshot-helper` in the operator's namespace. This helper mounts the snapshots PVC and executes `tar`, `find`, and `cat` commands on behalf of the operator and API.

This design avoids mounting the snapshots PVC in every tenant Pod and lets the operator share one volume across the whole namespace.

## Storage Backend

Overlay archives are stored on a regular `PersistentVolumeClaim`. Configure the PVC size and storage class in the kustomize manifests under `config/deploy/`.

Listing snapshots is exposed via the API:

```bash
# All snapshots
curl http://localhost:3000/api/v1/snapshots

# Snapshots for a specific workload
curl http://localhost:3000/api/v1/workloads/my-agent/snapshots
```

Each entry:

```json
{
  "tenantId": "alice",
  "workloadRef": "my-agent",
  "path": "/snapshots/alice/my-agent.tar.gz"
}
```

## Idle Detection

The operator's idle monitor uses two signals to detect inactivity:

### Timeout

A simple timer. If no activity has been recorded on the claim for `idle.timeoutSeconds`, the operator triggers hibernation.

Activity is bumped by the API server on every claim, exec, and proxied request, via the `boilerhouse.dev/last-activity` annotation on the `BoilerhouseClaim`.

### Watch Directories

For workloads where filesystem activity indicates usage:

```yaml
idle:
  timeoutSeconds: 60
  action: hibernate
  watchDirs:
    - /root/.openclaw
```

The operator periodically checks the modification time of files in `watchDirs`. If files have been modified since the last check, the idle timer resets. This catches activity that doesn't generate network traffic (e.g., an agent writing files locally).
