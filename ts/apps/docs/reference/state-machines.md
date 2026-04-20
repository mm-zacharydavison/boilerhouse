# State Machines

Every Boilerhouse CRD has a `status.phase` field that follows a finite state machine. The operator writes phases; clients read them. CRD validation enforces the phase enums at the API server.

## BoilerhouseWorkload

Workloads are container blueprints.

```
Creating ──► Ready
         ──► Error ──► Creating (on retry)

Ready ──► Creating (on spec change)
      ──► Error
```

| From | To | Trigger |
|------|----|---------|
| `Creating` | `Ready` | Image is available and spec validates |
| `Creating` | `Error` | Build or validation failure |
| `Ready` | `Creating` | Spec change (new `observedGeneration`) |
| `Error` | `Creating` | Retry after operator restart or spec fix |

## BoilerhousePool

Pools maintain warm Pods for a workload.

```
Healthy ──► Degraded ──► Healthy
        ──► Error
```

| From | To | Trigger |
|------|----|---------|
| `Healthy` | `Degraded` | `ready < size` (e.g., a warm Pod failed and is being replaced) |
| `Degraded` | `Healthy` | `ready >= size` |
| `Healthy` / `Degraded` | `Error` | Referenced workload missing, or persistent image-pull failure |

The `status.ready` and `status.warming` counters track the underlying Pods so you don't have to infer them from the phase.

## BoilerhouseClaim

Claims bind tenants to Pods. Most of the system's liveness concerns are in this state machine.

```
Pending ──► Active ──► Releasing ──► Released
                                 ──► ReleaseFailed
        ──► Error
```

| From | To | Trigger |
|------|----|---------|
| `Pending` | `Active` | Pod assigned and healthy; endpoint written |
| `Pending` | `Error` | Workload missing, capacity exhausted, or reconcile failure |
| `Active` | `Releasing` | Claim deleted, or idle timeout fired |
| `Releasing` | `Released` | Overlay extracted, Pod destroyed |
| `Releasing` | `ReleaseFailed` | Overlay extraction failed — Pod may still exist and need manual cleanup |

The `source` field on `status` records how the instance was acquired (`existing`, `cold`, `cold+data`, `pool`, `pool+data`) and is written once when transitioning to `Active`.

### Idle-Triggered Release

Idle release follows the same `Active → Releasing → Released` path. The operator sets `status.detail` to indicate the release was idle-triggered rather than user-initiated.

### Revival After Hibernation

To reclaim a hibernated tenant, delete the old `Released` Claim (the API does this for you) and create a new Claim with the same `tenantId` and `workloadRef`. The operator detects the saved overlay and sets `source` to `pool+data` or `cold+data`.

## BoilerhouseTrigger

Triggers are long-lived configuration.

```
Active ──► Error ──► Active
```

| From | To | Trigger |
|------|----|---------|
| `Active` | `Error` | Adapter failed to start (missing secret, invalid config) |
| `Error` | `Active` | Config fixed, adapter restarted by the trigger gateway |

## Pod Phase (Instance)

Boilerhouse does not invent a new phase for instances — Pods use the standard Kubernetes `Pod.status.phase`:

```
Pending ──► Running ──► Succeeded / Failed
```

The operator enriches Pods with labels (`boilerhouse.dev/*`) so you can correlate them back to Workloads, Pools, Claims, and Tenants.
