# Trigger Driver Plugins — Design Spec

## Goal

Port the `claude-code` and `openclaw` drivers from the retired TypeScript codebase into the Go port, but implement them as out-of-process plugin binaries rather than compiled-in gateway code. Establish a plugin mechanism that first-party drivers use and that third parties can extend. Add example trigger templates that use these drivers together with the existing telegram adapter and allowlist guard. Surface loaded plugins (and load errors) in the dashboard.

Guards remain compiled-in for now; guard plugins are a follow-up that reuses this design.

## Scope

- New plugin mechanism for trigger drivers, using `hashicorp/go-plugin` with gRPC transport.
- First-party plugin binaries: `claude-code` (WebSocket) and `openclaw` (HTTP + SSE).
- Gateway-side plugin registry with startup-time discovery, lifecycle management, and a read-only HTTP state endpoint.
- Per-driver `driverOptions` passthrough with gateway-resolved Secret references (plugins never see K8s).
- Telegram adapter gains `botTokenSecretRef` so templates can reference a Secret instead of embedding a literal token.
- API server exposes `GET /api/v1/plugins`, proxied from the trigger gateway.
- Dashboard grows a read-only Plugins page.
- Two example trigger YAMLs — `workloads/claude-code-trigger.yaml`, `workloads/openclaw-trigger.yaml` — targeting the existing `claude-code` and `openclaw` Workloads.

## Non-goals

- Guard plugins. Same mechanism will later apply, but not in this spec.
- Plugin crash supervision / restart-on-exit. A plugin subprocess that dies is treated as unavailable until the gateway restarts; events routed to it fail.
- Dashboard actions (reload / disable / re-scan). The Plugins page is read-only in this pass.
- Runtime hot-reload of plugins. Discovery is startup-only.
- Distribution via mounted volumes. Plugins ship baked into the boilerhouse trigger container image; users extend by building a custom image `FROM` it. (Volume-mount distribution is a revisitable follow-up.)

## Architecture

```
boilerhouse trigger container image
┌─────────────────────────────────────────────────┐
│ /usr/bin/boilerhouse-trigger   ← main gateway   │
│ /plugins/drivers/                               │
│   ├── claude-code   ← first-party plugin binary │
│   ├── openclaw      ← first-party plugin binary │
│   └── <user-plugin> ← added via a Dockerfile    │
│                        FROM boilerhouse-trigger │
└─────────────────────────────────────────────────┘

At gateway startup:
  1. Scan $BOILERHOUSE_PLUGIN_DIR (default /plugins/drivers/).
  2. For each executable: plugin.Client spawns subprocess, performs
     the shared handshake, resolves a gRPC client for the "driver"
     dispense name, calls Name() to learn the declared driver name,
     and registers it in an in-memory map.
  3. Subprocesses live for the gateway's lifetime. SIGTERM → Kill()
     on each client.

Per event:
  - buildDriver() returns DefaultDriver when driver is "" or "default".
  - Otherwise looks up by name in the plugin registry; on miss returns
    a misconfiguredDriver that denies every event with a clear error.
  - For plugins, driverOptions are parsed gateway-side: known *SecretRef
    fields are resolved against the K8s client and substituted with the
    literal value. The plugin receives resolved-options bytes only.

Plugins speak gRPC over the local unix socket that hashicorp/go-plugin
manages. No network exposure; no plugin-side K8s access.
```

### What lives where

| Location | Content |
|----------|---------|
| `go/pkg/driverplugin/` | Public Go interface, gRPC proto + generated code, shared handshake config, `plugin.Plugin` implementation. Imported by both gateway and plugin binaries. |
| `go/internal/trigger/driver.go` | `Driver` interface (updated signature), `DefaultDriver`, `misconfiguredDriver`. |
| `go/internal/trigger/driver_plugin.go` | Adapter that wraps a loaded plugin's gRPC client and implements `Driver`. |
| `go/internal/trigger/plugin_registry.go` | Startup-time plugin discovery, lifecycle, name-indexed lookup, state export. |
| `go/internal/trigger/plugins_http.go` | Read-only HTTP listener on `:8091` serving `GET /plugins`. |
| `go/cmd/trigger/main.go` | Wires the registry + HTTP listener into the gateway startup/shutdown path. |
| `go/cmd/driver-claude-code/` | First-party plugin binary — WebSocket client against the workload's `/ws` bridge. |
| `go/cmd/driver-openclaw/` | First-party plugin binary — HTTP + SSE client against the workload's `/v1/chat/completions`. |
| `go/internal/api/routes_plugins.go` | API route `GET /api/v1/plugins` proxying to the trigger gateway. |
| `ts/apps/dashboard/src/pages/PluginList.tsx` | Dashboard page listing loaded plugins + load errors. |
| `workloads/claude-code-trigger.yaml`, `workloads/openclaw-trigger.yaml` | Example BoilerhouseTrigger manifests. |

## Plugin interface

Public Go interface in `go/pkg/driverplugin/`:

```go
type DriverPlugin interface {
    // Name returns the driver name the plugin registers as.
    // Called once at load time.
    Name(ctx context.Context) (string, error)

    // Send runs a single trigger event against the workload instance endpoint.
    Send(ctx context.Context, req SendRequest) (SendResponse, error)
}

type SendRequest struct {
    Endpoint string          // e.g. "http://10.0.0.5:7880"
    TenantId string
    Payload  TriggerPayload  // mirrors trigger.TriggerPayload
    Options  json.RawMessage // trigger.Spec.DriverOptions with secrets resolved
}

type SendResponse struct {
    Text string                  // response text, used by the telegram reply path
    Raw  map[string]any          // optional structured response
}
```

### gRPC proto

`go/pkg/driverplugin/proto/driverplugin.proto`:

```proto
syntax = "proto3";

package driverplugin;

service DriverPlugin {
    rpc Name(NameRequest) returns (NameResponse);
    rpc Send(SendRequest) returns (SendResponse);
}

message NameRequest {}
message NameResponse { string name = 1; }

message Payload {
    string text   = 1;
    string source = 2;
    bytes  raw    = 3;  // JSON-encoded "any"
}

message SendRequest {
    string  endpoint  = 1;
    string  tenant_id = 2;
    Payload payload   = 3;
    bytes   options   = 4;  // raw JSON
}

message SendResponse {
    string text = 1;
    bytes  raw  = 2;  // JSON-encoded "any"
}
```

### Handshake config

```go
// Shared between gateway and plugin binaries.
var Handshake = plugin.HandshakeConfig{
    ProtocolVersion:  1,
    MagicCookieKey:   "BOILERHOUSE_DRIVER_PLUGIN",
    MagicCookieValue: "boilerhouse-driver-v1",
}

var PluginMap = map[string]plugin.Plugin{
    "driver": &DriverGRPCPlugin{}, // implements plugin.GRPCPlugin
}
```

Protocol version `1` is for this first cut. Any breaking change to the protocol bumps it; mismatched versions cause handshake failure, which surfaces in the registry as an error entry.

## Plugin discovery and lifecycle

### Discovery

On startup, the registry walks `$BOILERHOUSE_PLUGIN_DIR` (default `/plugins/drivers/`). For each entry:

1. Skip if not a regular file or not executable.
2. Construct `plugin.ClientConfig{ Plugins: driverplugin.PluginMap, Cmd: exec.Command(path), HandshakeConfig: driverplugin.Handshake, AllowedProtocols: []plugin.Protocol{plugin.ProtocolGRPC}, Logger: hclog-wrapper-around-slog }`.
3. `client.Client().Dispense("driver")` — yields a gRPC client implementing `DriverPlugin`.
4. Call `Name(ctx)` — returns the declared driver name.
5. If the name is already registered, log an error, `Kill()` the new client, and record the duplicate as an error entry. First-registered wins.
6. Otherwise store in `map[string]*loadedPlugin`.

If any step fails (bad handshake, non-executable binary, panic, timeout), log at `warn` and record an error entry with the binary path and error string. Other plugins are unaffected. Discovery is non-fatal: an empty directory yields a functional gateway with zero plugins.

### Lifecycle

One `plugin.Client` per binary; owned by the registry. Subprocesses run for the entire gateway process lifetime. On `Gateway.Sync` context cancellation, the registry's `Close()` calls `Kill()` on every client (go-plugin's default graceful shutdown).

No restart supervision. If a subprocess exits unexpectedly, its next `Send` fails with an error, and the triggering event fails with `"driver check failed"`. Adding restart supervision is tracked as future work but is not in this spec.

### State export

The registry exposes:

```go
type PluginState struct {
    Name     string    `json:"name,omitempty"`      // present only when loaded
    Kind     string    `json:"kind"`                // always "driver" for now
    Binary   string    `json:"binary"`              // absolute filesystem path
    Status   string    `json:"status"`              // "loaded" | "error"
    Error    string    `json:"error,omitempty"`     // present only when status == "error"
    LoadedAt time.Time `json:"loadedAt,omitempty"`  // present only when loaded
    FailedAt time.Time `json:"failedAt,omitempty"`  // present only when errored
}

type PluginRegistry interface {
    Driver(name string) (Driver, bool)
    State() []PluginState
    Close() error
}
```

The HTTP listener (§Plugin state HTTP) calls `State()` on each request.

## Gateway wiring

### Driver interface update

`go/internal/trigger/driver.go` — `Driver.Send` signature becomes:

```go
type Driver interface {
    Send(ctx context.Context, endpoint, tenantId string, payload TriggerPayload) (any, error)
}
```

`DefaultDriver` updates to match (ignores `tenantId`). The `misconfiguredDriver` returns `fmt.Errorf("driver misconfigured: %s", reason)` from every `Send`, mirroring the `APIGuard` pattern.

### buildDriver

Called from `Gateway.buildHandler(ctx, trigger)`:

```go
switch trigger.Spec.Driver {
case "", "default":
    return NewDefaultDriver(nil)
default:
    raw, ok := g.plugins.Driver(trigger.Spec.Driver)
    if !ok {
        return &misconfiguredDriver{reason: fmt.Sprintf("driver %q not loaded", trigger.Spec.Driver)}
    }
    return g.resolveOptionsForPlugin(ctx, trigger, raw)
}
```

### Options resolution

`resolveOptionsForPlugin` unmarshals `trigger.Spec.DriverOptions.Raw` into a generic `map[string]any`, walks it for known `*SecretRef` keys (currently only `gatewayTokenSecretRef` for the openclaw driver), and substitutes each with the resolved Secret value. Unknown fields pass through untouched. The resulting map is re-marshalled into bytes and carried in every `SendRequest.Options` for that trigger.

The Secret lookup uses the gateway's existing controller-runtime client. On lookup failure (not found, missing key, RBAC denied), `resolveOptionsForPlugin` returns a `misconfiguredDriver` whose reason string includes the underlying error. Consistent with `APIGuard` behavior for Secret-backed config.

Secret resolution happens once per trigger at `buildHandler` time (same lifetime as guard construction), not per event. If the Secret rotates, the trigger has to be restarted — matches the telegram adapter, the openclaw workload's env var, and the API guard.

### Telegram bot-token resolution

Independent of plugins. `go/internal/trigger/adapter_telegram.go` gains:

```go
type telegramConfig struct {
    BotToken           string
    BotTokenSecretRef  *secretRef // {Name, Key} — existing shape from guard_api.go
    UpdateTypes        []string
    PollTimeoutSeconds int
    APIBaseURL         string
}
```

`parseTelegramConfig` accepts either `botToken` (literal) or `botTokenSecretRef` (Secret reference). Exactly one must be set; otherwise `parseTelegramConfig` returns an error.

`Gateway.buildAdapter` for the `telegram` case resolves `botTokenSecretRef` against the gateway's K8s client before calling `NewTelegramAdapter`, substituting the literal token into the config map that the adapter already consumes. On failure it returns an error — existing `syncOnce` behavior logs and leaves the trigger inactive.

The adapter itself stays unchanged after construction; it only ever sees a resolved token string.

## Plugin state HTTP

New file `go/internal/trigger/plugins_http.go`. Binds `:8091` by default (overridable via `PLUGIN_HTTP_ADDR` env var, mostly for tests). Serves one route:

```
GET /plugins
→ 200 OK, application/json
  { "plugins": [ {PluginState}, ... ] }
```

Read-only, no auth (same trust boundary as the existing webhook-adapter listener). Started from `go/cmd/trigger/main.go` alongside `Gateway.Sync`; shares the same cancellation context, so graceful shutdown is automatic.

### API proxy route

`go/internal/api/routes_plugins.go`:

- `GET /api/v1/plugins` → fetches from `$TRIGGER_GATEWAY_URL/plugins` (default `http://boilerhouse-trigger.<namespace>.svc:8091`) and forwards the response body verbatim on success.
- Upstream 5xx or network error → `502 Bad Gateway` with a JSON body describing the failure. Upstream non-200 / non-5xx → pass through.
- 3-second timeout on the proxied call.

### Deploy manifest change

`config/deploy/trigger.yaml` currently declares only a Deployment. This spec adds a companion Service so the API server can resolve the trigger gateway by DNS:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: boilerhouse-trigger
  namespace: boilerhouse
spec:
  selector:
    app: boilerhouse-trigger
  ports:
    - name: plugins-http
      port: 8091
      targetPort: 8091
```

The trigger Deployment's container `ports` list gains a `containerPort: 8091, name: plugins-http` entry.

## First-party plugin binaries

### `go/cmd/driver-claude-code/`

```
main.go          — plugin.Serve with driverplugin.Handshake + driverplugin.PluginMap
driver.go        — DriverPlugin implementation
driver_test.go   — protocol tests against a fake WS server
```

Implements the protocol that `workloads/claude-code/bridge.mjs` expects:

1. Dials `ws://<endpoint>/ws` with a 10-second timeout using `github.com/gorilla/websocket`.
2. Sends `{"type":"init","tenantId":"<tenant>"}` — waits for `{"type":"ready"}` (10-second timeout).
3. Sends `{"type":"prompt","text":"<payload.text>"}`.
4. Reads messages in a loop, concatenating every `{"type":"output","text":...}` chunk. Stops on `{"type":"idle"}` (returns concatenated text) or `{"type":"exit","code":N,"stderr":"..."}` (returns `"Claude Code exited with code N\n<stderr>"` if no text was collected).
5. Overall timeout: 300 seconds. On timeout or connection error, returns an error.

No options — `SendRequest.Options` is ignored.

### `go/cmd/driver-openclaw/`

```
main.go          — plugin.Serve
driver.go        — DriverPlugin implementation
driver_test.go   — SSE client tests
```

Implements the protocol expected by the openclaw workload:

1. Parses `SendRequest.Options` as `{"gatewayToken":"<resolved>"}`. Missing token → error.
2. `POST <endpoint>/v1/chat/completions`, headers:
   - `Content-Type: application/json`
   - `Authorization: Bearer <gatewayToken>`
   - `X-OpenClaw-Session-Key: <tenantId>`
   Body: `{"model":"openclaw","messages":[{"role":"user","content":"<payload.text>"}],"stream":true}`.
3. Non-2xx response → error including status code.
4. Scans SSE lines from the response body. For each `data: <json>` line (ignoring `[DONE]`), parses and appends `choices[0].delta.content` to an accumulator. Malformed lines are skipped.
5. Returns the accumulated text. No overall timeout on the SSE read — the stream terminates naturally when the server closes the connection.

Uses stdlib `net/http` + `bufio.Scanner`. No new module dependencies.

## Dashboard

New page `ts/apps/dashboard/src/pages/PluginList.tsx`:

- Calls a new `api.listPlugins()` function (added to `ts/apps/dashboard/src/api.ts`) that hits `GET /api/v1/plugins`.
- Renders a table: **Name** | **Kind** | **Binary path** | **Status** (badge: green for `loaded`, red for `error`) | **Loaded at / failed at** (relative time).
- When a row has `status === "error"`, an expandable details section shows the raw `error` string.
- Read-only. No actions.

Navigation entry added to the existing sidebar, positioned next to Triggers. Styling follows `TriggerList.tsx`.

## Example templates

### `workloads/claude-code-trigger.yaml`

```yaml
apiVersion: boilerhouse.dev/v1alpha1
kind: BoilerhouseTrigger
metadata:
  name: tg-claude-code
  namespace: boilerhouse
spec:
  type: telegram
  workloadRef: claude-code
  tenant:
    from: usernameOrId
    prefix: "tg-"
  driver: claude-code
  guards:
    - type: allowlist
      config:
        tenantIds:
          - tg-alice
          - tg-bob
        denyMessage: "You are not authorized to use this agent."
  config:
    botTokenSecretRef:
      name: telegram-bot-token
      key: token
    updateTypes: [message]
    pollTimeoutSeconds: 30
```

### `workloads/openclaw-trigger.yaml`

```yaml
apiVersion: boilerhouse.dev/v1alpha1
kind: BoilerhouseTrigger
metadata:
  name: tg-openclaw
  namespace: boilerhouse
spec:
  type: telegram
  workloadRef: openclaw
  tenant:
    from: usernameOrId
    prefix: "tg-"
  driver: openclaw
  driverOptions:
    gatewayTokenSecretRef:
      name: openclaw-gateway-token
      key: token
  guards:
    - type: allowlist
      config:
        tenantIds:
          - tg-alice
          - tg-bob
        denyMessage: "You are not authorized to use this agent."
  config:
    botTokenSecretRef:
      name: telegram-bot-token
      key: token
    updateTypes: [message]
    pollTimeoutSeconds: 30
```

Each template ships with a header comment listing the prerequisite Secrets:

```
# Prereq: create these Secrets in the boilerhouse namespace before applying:
#
#   kubectl -n boilerhouse create secret generic telegram-bot-token \
#     --from-literal=token="<your telegram bot token>"
#
#   kubectl -n boilerhouse create secret generic openclaw-gateway-token \
#     --from-literal=token="<openclaw gateway token>"
#
# Update the allowlist tenantIds with the telegram usernames/ids that
# should be permitted.
```

## Testing

### Package `driverplugin` (public)

`go/pkg/driverplugin/driverplugin_test.go` — round-trip test: fake in-process gRPC server implementing `DriverPlugin`, client calls `Send`, asserts request and response are faithfully serialized (including `Options` as opaque bytes, `Payload.Raw` as encoded JSON).

### `go/cmd/driver-claude-code/driver_test.go`

Pure WebSocket protocol tests — no plugin framing:

- **Successful prompt.** `httptest.Server` upgrades to WebSocket, asserts `{init, tenantId}` arrives, replies `{ready}`, asserts `{prompt, text}` arrives, sends two `{output}` chunks + `{idle}`. Driver returns concatenated text.
- **Exit path.** Same setup but server emits `{exit, code: 1, stderr: "boom"}` after prompt. Driver returns an error-containing text.
- **Handshake timeout.** Server accepts WS but never sends `{ready}`. Driver fails closed with a timeout error.
- **Connection refused.** Driver returns an error.

### `go/cmd/driver-openclaw/driver_test.go`

Pure HTTP + SSE tests:

- **Successful completion.** `httptest.Server` asserts headers and body shape, streams three SSE `data:` chunks + `[DONE]`. Driver returns concatenated content.
- **Missing gatewayToken in Options.** Driver returns an error before any HTTP call.
- **Non-2xx response.** Driver returns an error containing the status code.
- **Malformed SSE line.** Driver skips the line, returns whatever did decode cleanly.

### `go/internal/trigger/plugin_registry_test.go`

Registry semantics using an injectable loader so no real subprocesses are spawned:

- Directory scan ignores non-regular and non-executable files.
- Two plugins declaring the same name: first wins, second is killed, duplicate is recorded as an error entry.
- State includes error entries for binaries that fail handshake (simulated via the fake loader).
- `Close()` kills every loaded plugin.

### `go/internal/trigger/plugin_e2e_test.go`

Exercises the full go-plugin + gRPC stack once.

1. Builds a tiny plugin binary from `testdata/fakeplugin/` using `go build` invoked from the test.
2. Points `BOILERHOUSE_PLUGIN_DIR` at a temp dir containing the compiled binary.
3. Constructs a registry, resolves the plugin, invokes `Send` through the real gRPC transport.
4. Asserts round-trip correctness.

### `go/internal/trigger/gateway_test.go` (extensions)

- `buildDriver` resolves `driver: "claude-code"` to a registered plugin, `driver: ""` to `DefaultDriver`, `driver: "missing"` to a `misconfiguredDriver`. Uses a fake `PluginRegistry` — no real subprocess.
- `buildAdapter` resolves `telegram.botTokenSecretRef` against a fake K8s client. Missing Secret → error; adapter not started.
- `resolveOptionsForPlugin` resolves `openclaw.gatewayTokenSecretRef` and substitutes into `SendRequest.Options`. Missing Secret → `misconfiguredDriver`.

### `go/internal/api/routes_plugins_test.go`

- Handler proxies `/api/v1/plugins` to a fake upstream (`httptest.Server` playing the trigger gateway), returns the list verbatim.
- Upstream 500 → `502 Bad Gateway` with a descriptive body.
- Upstream timeout → `502 Bad Gateway`.

### Dashboard

No unit test — matches the existing dashboard codebase style. Manual verification in a running cluster at ship time.

### Out of scope

- Plugin crash / restart behavior (no supervision implemented).
- Load testing / latency characterization of the gRPC hop.

## Open risks

- **hashicorp/go-plugin dependency weight.** Adds a reasonably large set of transitive deps (hclog, grpc, protobuf). Acceptable given it's the de-facto Go plugin library and the project already depends on gRPC via controller-runtime's build chain.
- **Plugin binary build discipline.** Plugin binaries must be built for the runtime OS/arch of the gateway pod (`linux/amd64` typically). This is a documentation concern more than a code concern; the first-party images cross-compile as part of CI.
- **gRPC hop latency.** One extra local IPC per event for plugin-routed triggers. Measured in sub-millisecond on loopback; well within the trigger-event latency budget.
- **Secret rotation blind spot.** Both the openclaw gateway token and the telegram bot token are resolved at trigger-reconcile time and cached on the built adapter/driver for the adapter's lifetime. If rotated, the trigger must be restarted. Consistent with current behavior for all in-gateway Secret usage.
