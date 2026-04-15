# State Machines

Every core entity in Boilerhouse follows a finite state machine. Transitions are validated at runtime — attempting an invalid transition throws an `InvalidTransitionError` (HTTP 409 in the API).

## Instance

Instances represent running containers. This is the most complex state machine.

```
starting ──→ active
         ──→ restoring
         ──→ destroying ──→ destroyed
         ──→ destroyed

restoring ──→ active
          ──→ destroying

active ──→ hibernating ──→ hibernated
       ──→ destroying              ──→ restoring
       ──→ destroyed               ──→ destroying

hibernating ──→ destroying

destroying ──→ destroyed
```

| From | To | Trigger | Description |
|------|----|---------|-------------|
| `starting` | `active` | `started` | Boot completed, health checks passing |
| `starting` | `restoring` | `restoring` | Snapshot restore initiated |
| `starting` | `destroying` | `destroy` | Boot failed or cancelled |
| `starting` | `destroyed` | `recover` | Force recovery to terminal state |
| `restoring` | `active` | `restored` | Restore completed, healthy |
| `restoring` | `destroying` | `destroy` | Restore failed |
| `active` | `hibernating` | `hibernate` | Idle timeout reached |
| `active` | `destroying` | `destroy` | Explicit destruction |
| `active` | `destroyed` | `recover` | Force recovery |
| `hibernating` | `hibernated` | `hibernated` | Snapshot saved |
| `hibernating` | `destroying` | `hibernating_failed` | Snapshot failed |
| `hibernated` | `restoring` | `restoring` | Resume from hibernation |
| `hibernated` | `destroying` | `destroy` | Explicit destruction |
| `destroying` | `destroyed` | `destroyed` | Teardown complete |

## Claim

Claims bind tenants to instances.

```
creating ──→ active ──→ releasing ──→ active (cycle for hibernation recovery)
```

| From | To | Trigger | Description |
|------|----|---------|-------------|
| `creating` | `active` | `created` | Instance assigned |
| `active` | `releasing` | `release` | Release initiated (idle or explicit) |
| `releasing` | `active` | `recover` | Re-claimed after hibernation |

::: info
The `releasing → active` transition enables the hibernation-resume cycle: a tenant's claim stays alive across hibernation so that the next claim restores state rather than starting fresh.
:::

## Workload

Workloads are container blueprints.

```
creating ──→ ready
         ──→ error ──→ creating (retry)

ready ──→ creating (on update)
```

| From | To | Trigger | Description |
|------|----|---------|-------------|
| `creating` | `ready` | `created` | Pool warmed, health checks passing |
| `creating` | `error` | `failed` | Build or health failure |
| `ready` | `creating` | `retry` | Workload updated, re-priming |
| `error` | `creating` | `recover` | Retry after failure |

## Tenant

Tenants are users or agents that claim instances.

```
idle ──→ claiming ──→ active ──→ releasing ──→ idle
                  ──→ idle                  ──→ released ──→ claiming
                                            ──→ active

active ──→ claiming (re-claim for different workload)
```

| From | To | Trigger | Description |
|------|----|---------|-------------|
| `idle` | `claiming` | `claim` | Claim requested |
| `claiming` | `active` | `claimed` | Instance assigned |
| `claiming` | `idle` | `claim_failed` | Claim failed |
| `active` | `claiming` | `claim` | Re-claim (different workload) |
| `active` | `releasing` | `release` | Release initiated |
| `releasing` | `released` | `hibernated` | Hibernation complete |
| `releasing` | `idle` | `destroyed` | Instance destroyed |
| `releasing` | `active` | `recover` | Re-activated |
| `released` | `claiming` | `claim` | New claim after release |

## Snapshot

Snapshots store persisted tenant or workload state.

```
creating ──→ ready ──→ expired ──→ deleted
                   ──→ deleted

creating ──→ deleted (capture failed)
```

| From | To | Trigger | Description |
|------|----|---------|-------------|
| `creating` | `ready` | `created` | Capture succeeded |
| `creating` | `deleted` | `failed` | Capture failed |
| `ready` | `expired` | `expire` | TTL reached |
| `ready` | `deleted` | `delete` | Explicit deletion |
| `expired` | `deleted` | `delete` | Cleanup |

## Node

Nodes are host machines running containers.

```
online ──→ draining ──→ offline ──→ online
                    ──→ online (cancel drain)
```

| From | To | Trigger | Description |
|------|----|---------|-------------|
| `online` | `draining` | `drain` | Stop accepting new instances |
| `draining` | `offline` | `shutdown` | All instances drained |
| `draining` | `online` | `cancel_drain` | Drain cancelled |
| `offline` | `online` | `activate` | Node brought back online |

::: tip
When a node is draining, existing instances continue running but no new instances are scheduled to it. Use this for rolling upgrades or maintenance windows.
:::
