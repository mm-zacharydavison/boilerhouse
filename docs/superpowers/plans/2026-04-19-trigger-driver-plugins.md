# Trigger Driver Plugins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement an out-of-process driver plugin system using `hashicorp/go-plugin` + gRPC, port the `claude-code` and `openclaw` drivers as first-party plugin binaries, surface loaded plugins in the dashboard, and ship example trigger templates.

**Architecture:** Plugins are standalone Go binaries spawned as subprocesses by the trigger gateway at startup. They implement a `DriverPlugin` gRPC service. The gateway indexes them by a self-declared name, resolves `driverOptions` (including Secret refs) gateway-side before each `Send`, and wraps each plugin as an in-process `Driver`. First-party plugins (`claude-code`, `openclaw`) ship baked into the trigger container image at `/plugins/drivers/`. A read-only HTTP endpoint on the gateway (proxied through the API server) exposes plugin state to the dashboard.

**Tech Stack:** Go 1.26, `hashicorp/go-plugin`, gRPC + protobuf, `gorilla/websocket` (already in deps), stdlib `net/http` for SSE, controller-runtime for K8s access, React + TypeScript dashboard.

---

## Preconditions

Before starting, confirm the repo layout.

- [ ] **Check** `go/go.mod` has module path `github.com/zdavison/boilerhouse/go`. Run:
  ```bash
  head -1 go/go.mod
  ```
  Expected: `module github.com/zdavison/boilerhouse/go`

- [ ] **Check** the existing Driver interface before any edits. Run:
  ```bash
  grep -n "^type Driver interface\|^func (d \*DefaultDriver)" go/internal/trigger/driver.go
  ```
  Expected: `type Driver interface` at one line, `func (d *DefaultDriver) Send` at another.

- [ ] **Install `protoc` and Go plugins** if not already present. Run:
  ```bash
  which protoc protoc-gen-go protoc-gen-go-grpc
  ```
  If missing:
  ```bash
  brew install protobuf
  go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
  go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest
  ```

- [ ] **Add module deps.** Run from `go/`:
  ```bash
  cd go && go get github.com/hashicorp/go-plugin@latest google.golang.org/grpc@latest google.golang.org/protobuf@latest && go mod tidy
  ```

---

## Task 1: DriverPlugin Go interface + handshake (no gRPC yet)

The public package that plugins and gateway both import. Starting with pure Go so we can test the interface shape before adding gRPC machinery.

**Files:**
- Create: `go/pkg/driverplugin/driverplugin.go`
- Create: `go/pkg/driverplugin/driverplugin_test.go`

- [ ] **Step 1: Create the package file.**

Write `go/pkg/driverplugin/driverplugin.go`:

```go
// Package driverplugin defines the contract between the boilerhouse trigger
// gateway and driver plugin binaries. Both the gateway and each plugin binary
// import this package; it is the only stable API surface between them.
package driverplugin

import (
	"context"
	"encoding/json"

	"github.com/hashicorp/go-plugin"
)

// DriverPlugin is implemented by plugin binaries. One method — Send — mirrors
// the in-process trigger.Driver interface, with tenantId promoted to a
// first-class argument and driver-specific options carried as opaque JSON.
type DriverPlugin interface {
	// Name returns the driver name the plugin registers as (e.g. "claude-code").
	// Called once at load time by the gateway.
	Name(ctx context.Context) (string, error)

	// Send runs a single trigger event against the workload instance endpoint
	// and returns the driver's response.
	Send(ctx context.Context, req SendRequest) (SendResponse, error)
}

// TriggerPayload mirrors the gateway-side trigger.TriggerPayload. Kept here
// so plugin authors don't have to import internal packages.
type TriggerPayload struct {
	Text   string `json:"text"`
	Source string `json:"source"`
	Raw    any    `json:"raw,omitempty"`
}

// SendRequest is what the gateway sends to a plugin per event.
type SendRequest struct {
	Endpoint string          `json:"endpoint"`
	TenantId string          `json:"tenantId"`
	Payload  TriggerPayload  `json:"payload"`
	Options  json.RawMessage `json:"options,omitempty"`
}

// SendResponse is what a plugin returns to the gateway.
type SendResponse struct {
	Text string         `json:"text,omitempty"`
	Raw  map[string]any `json:"raw,omitempty"`
}

// Handshake is shared between the gateway and plugin binaries. Any breaking
// change to the wire protocol bumps ProtocolVersion.
var Handshake = plugin.HandshakeConfig{
	ProtocolVersion:  1,
	MagicCookieKey:   "BOILERHOUSE_DRIVER_PLUGIN",
	MagicCookieValue: "boilerhouse-driver-v1",
}

// DispenseKey is the name plugins serve their DriverPlugin implementation under.
const DispenseKey = "driver"
```

- [ ] **Step 2: Write a trivial test that the types compile and round-trip through JSON.**

Write `go/pkg/driverplugin/driverplugin_test.go`:

```go
package driverplugin

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSendRequest_JSONRoundtrip(t *testing.T) {
	original := SendRequest{
		Endpoint: "http://10.0.0.5:7880",
		TenantId: "tg-alice",
		Payload: TriggerPayload{
			Text:   "hello",
			Source: "telegram",
			Raw:    map[string]any{"chatId": float64(12345)},
		},
		Options: json.RawMessage(`{"gatewayToken":"s3cret"}`),
	}

	data, err := json.Marshal(original)
	require.NoError(t, err)

	var decoded SendRequest
	require.NoError(t, json.Unmarshal(data, &decoded))

	assert.Equal(t, original.Endpoint, decoded.Endpoint)
	assert.Equal(t, original.TenantId, decoded.TenantId)
	assert.Equal(t, original.Payload.Text, decoded.Payload.Text)
	assert.Equal(t, original.Payload.Source, decoded.Payload.Source)
	assert.JSONEq(t, string(original.Options), string(decoded.Options))
}

func TestHandshake_HasExpectedConstants(t *testing.T) {
	assert.Equal(t, uint(1), Handshake.ProtocolVersion)
	assert.Equal(t, "BOILERHOUSE_DRIVER_PLUGIN", Handshake.MagicCookieKey)
	assert.Equal(t, "boilerhouse-driver-v1", Handshake.MagicCookieValue)
	assert.Equal(t, "driver", DispenseKey)
}
```

- [ ] **Step 3: Run tests. They should compile once go-plugin is in `go.mod` (Preconditions).**

```bash
cd go && go test ./pkg/driverplugin/ -count=1 -v
```
Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add go/pkg/driverplugin/ go/go.mod go/go.sum
git commit -m "feat(driverplugin): add DriverPlugin interface + handshake constants"
```

---

## Task 2: gRPC proto + generated code + plugin.GRPCPlugin wiring

Add the gRPC transport so plugins can actually be spawned and called over a subprocess boundary.

**Files:**
- Create: `go/pkg/driverplugin/proto/driverplugin.proto`
- Create: `go/pkg/driverplugin/proto/driverplugin.pb.go` (generated)
- Create: `go/pkg/driverplugin/proto/driverplugin_grpc.pb.go` (generated)
- Create: `go/pkg/driverplugin/grpc.go`
- Modify: `go/pkg/driverplugin/driverplugin.go`

- [ ] **Step 1: Write the proto.**

Create `go/pkg/driverplugin/proto/driverplugin.proto`:

```proto
syntax = "proto3";

package driverplugin;

option go_package = "github.com/zdavison/boilerhouse/go/pkg/driverplugin/proto";

service DriverPlugin {
    rpc Name(NameRequest) returns (NameResponse);
    rpc Send(SendRequest) returns (SendResponse);
}

message NameRequest {}
message NameResponse { string name = 1; }

message Payload {
    string text   = 1;
    string source = 2;
    bytes  raw    = 3; // JSON-encoded "any"
}

message SendRequest {
    string  endpoint  = 1;
    string  tenant_id = 2;
    Payload payload   = 3;
    bytes   options   = 4; // raw JSON
}

message SendResponse {
    string text = 1;
    bytes  raw  = 2; // JSON-encoded "any"
}
```

- [ ] **Step 2: Generate the Go code.**

From the repo root:

```bash
protoc \
  --go_out=go/pkg/driverplugin/proto --go_opt=paths=source_relative \
  --go-grpc_out=go/pkg/driverplugin/proto --go-grpc_opt=paths=source_relative \
  --proto_path=go/pkg/driverplugin/proto \
  go/pkg/driverplugin/proto/driverplugin.proto
```

This writes `driverplugin.pb.go` and `driverplugin_grpc.pb.go`. Commit both — do not gitignore generated proto code (matches controller-runtime convention).

- [ ] **Step 3: Write the gRPC bridge.**

Create `go/pkg/driverplugin/grpc.go`:

```go
package driverplugin

import (
	"context"
	"encoding/json"

	"github.com/hashicorp/go-plugin"
	"google.golang.org/grpc"

	pb "github.com/zdavison/boilerhouse/go/pkg/driverplugin/proto"
)

// DriverGRPCPlugin implements plugin.GRPCPlugin for the DriverPlugin service.
type DriverGRPCPlugin struct {
	plugin.Plugin
	Impl DriverPlugin // set by the plugin binary; nil on the gateway side
}

// GRPCServer registers the plugin implementation with a gRPC server.
func (p *DriverGRPCPlugin) GRPCServer(_ *plugin.GRPCBroker, s *grpc.Server) error {
	pb.RegisterDriverPluginServer(s, &grpcServer{impl: p.Impl})
	return nil
}

// GRPCClient returns a client that implements DriverPlugin by calling across the gRPC boundary.
func (p *DriverGRPCPlugin) GRPCClient(_ context.Context, _ *plugin.GRPCBroker, c *grpc.ClientConn) (any, error) {
	return &grpcClient{client: pb.NewDriverPluginClient(c)}, nil
}

// PluginMap is the shared dispense registry. Used by both gateway and plugin binaries.
var PluginMap = map[string]plugin.Plugin{
	DispenseKey: &DriverGRPCPlugin{},
}

// --- client side (gateway) ---

type grpcClient struct {
	client pb.DriverPluginClient
}

func (c *grpcClient) Name(ctx context.Context) (string, error) {
	resp, err := c.client.Name(ctx, &pb.NameRequest{})
	if err != nil {
		return "", err
	}
	return resp.Name, nil
}

func (c *grpcClient) Send(ctx context.Context, req SendRequest) (SendResponse, error) {
	rawBytes, err := json.Marshal(req.Payload.Raw)
	if err != nil {
		return SendResponse{}, err
	}

	resp, err := c.client.Send(ctx, &pb.SendRequest{
		Endpoint: req.Endpoint,
		TenantId: req.TenantId,
		Payload: &pb.Payload{
			Text:   req.Payload.Text,
			Source: req.Payload.Source,
			Raw:    rawBytes,
		},
		Options: []byte(req.Options),
	})
	if err != nil {
		return SendResponse{}, err
	}

	var raw map[string]any
	if len(resp.Raw) > 0 {
		_ = json.Unmarshal(resp.Raw, &raw)
	}
	return SendResponse{Text: resp.Text, Raw: raw}, nil
}

// --- server side (plugin binary) ---

type grpcServer struct {
	pb.UnimplementedDriverPluginServer
	impl DriverPlugin
}

func (s *grpcServer) Name(ctx context.Context, _ *pb.NameRequest) (*pb.NameResponse, error) {
	name, err := s.impl.Name(ctx)
	if err != nil {
		return nil, err
	}
	return &pb.NameResponse{Name: name}, nil
}

func (s *grpcServer) Send(ctx context.Context, req *pb.SendRequest) (*pb.SendResponse, error) {
	var raw any
	if len(req.Payload.GetRaw()) > 0 {
		_ = json.Unmarshal(req.Payload.Raw, &raw)
	}

	out, err := s.impl.Send(ctx, SendRequest{
		Endpoint: req.Endpoint,
		TenantId: req.TenantId,
		Payload: TriggerPayload{
			Text:   req.Payload.GetText(),
			Source: req.Payload.GetSource(),
			Raw:    raw,
		},
		Options: json.RawMessage(req.Options),
	})
	if err != nil {
		return nil, err
	}

	var rawBytes []byte
	if out.Raw != nil {
		rawBytes, _ = json.Marshal(out.Raw)
	}
	return &pb.SendResponse{Text: out.Text, Raw: rawBytes}, nil
}
```

- [ ] **Step 4: Replace the test file with the full gRPC round-trip version.**

Rewrite `go/pkg/driverplugin/driverplugin_test.go` in full (keeps the two earlier tests plus the new gRPC test — one import block):

```go
package driverplugin

import (
	"context"
	"encoding/json"
	"net"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "github.com/zdavison/boilerhouse/go/pkg/driverplugin/proto"
)

func TestSendRequest_JSONRoundtrip(t *testing.T) {
	original := SendRequest{
		Endpoint: "http://10.0.0.5:7880",
		TenantId: "tg-alice",
		Payload: TriggerPayload{
			Text:   "hello",
			Source: "telegram",
			Raw:    map[string]any{"chatId": float64(12345)},
		},
		Options: json.RawMessage(`{"gatewayToken":"s3cret"}`),
	}

	data, err := json.Marshal(original)
	require.NoError(t, err)

	var decoded SendRequest
	require.NoError(t, json.Unmarshal(data, &decoded))

	assert.Equal(t, original.Endpoint, decoded.Endpoint)
	assert.Equal(t, original.TenantId, decoded.TenantId)
	assert.Equal(t, original.Payload.Text, decoded.Payload.Text)
	assert.Equal(t, original.Payload.Source, decoded.Payload.Source)
	assert.JSONEq(t, string(original.Options), string(decoded.Options))
}

func TestHandshake_HasExpectedConstants(t *testing.T) {
	assert.Equal(t, uint(1), Handshake.ProtocolVersion)
	assert.Equal(t, "BOILERHOUSE_DRIVER_PLUGIN", Handshake.MagicCookieKey)
	assert.Equal(t, "boilerhouse-driver-v1", Handshake.MagicCookieValue)
	assert.Equal(t, "driver", DispenseKey)
}

type fakeImpl struct {
	lastReq SendRequest
}

func (f *fakeImpl) Name(_ context.Context) (string, error) { return "fake", nil }
func (f *fakeImpl) Send(_ context.Context, req SendRequest) (SendResponse, error) {
	f.lastReq = req
	return SendResponse{Text: "ok: " + req.Payload.Text, Raw: map[string]any{"echoed": req.TenantId}}, nil
}

func TestGRPC_RoundTrip(t *testing.T) {
	impl := &fakeImpl{}

	lis, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer lis.Close()

	srv := grpc.NewServer()
	pb.RegisterDriverPluginServer(srv, &grpcServer{impl: impl})
	go func() { _ = srv.Serve(lis) }()
	defer srv.Stop()

	conn, err := grpc.NewClient(lis.Addr().String(), grpc.WithTransportCredentials(insecure.NewCredentials()))
	require.NoError(t, err)
	defer conn.Close()

	client := &grpcClient{client: pb.NewDriverPluginClient(conn)}

	name, err := client.Name(context.Background())
	require.NoError(t, err)
	assert.Equal(t, "fake", name)

	resp, err := client.Send(context.Background(), SendRequest{
		Endpoint: "http://workload",
		TenantId: "tg-alice",
		Payload:  TriggerPayload{Text: "hi", Source: "telegram", Raw: map[string]any{"chatId": float64(1)}},
		Options:  json.RawMessage(`{"foo":"bar"}`),
	})
	require.NoError(t, err)
	assert.Equal(t, "ok: hi", resp.Text)
	assert.Equal(t, "tg-alice", resp.Raw["echoed"])

	assert.Equal(t, "http://workload", impl.lastReq.Endpoint)
	assert.Equal(t, "tg-alice", impl.lastReq.TenantId)
	assert.Equal(t, "hi", impl.lastReq.Payload.Text)
	assert.JSONEq(t, `{"foo":"bar"}`, string(impl.lastReq.Options))
}
```

- [ ] **Step 5: Run tests.**

```bash
cd go && go test ./pkg/driverplugin/... -count=1 -v
```
Expected: PASS for both `TestSendRequest_JSONRoundtrip`, `TestHandshake_HasExpectedConstants`, and `TestGRPC_RoundTrip`.

- [ ] **Step 6: Commit.**

```bash
git add go/pkg/driverplugin/
git commit -m "feat(driverplugin): add gRPC transport + PluginMap"
```

---

## Task 3: Update Driver interface to include tenantId

The in-process interface change. Small but touches every call site.

**Files:**
- Modify: `go/internal/trigger/driver.go`
- Modify: `go/internal/trigger/gateway.go` (call site)
- Modify: `go/internal/trigger/gateway_test.go` (DefaultDriver tests)

- [ ] **Step 1: Write failing test for the new signature.**

Add to `go/internal/trigger/gateway_test.go` (at the end):

```go
func TestDefaultDriver_AcceptsTenantIdButIgnoresIt(t *testing.T) {
	var got TriggerPayload
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.NoError(t, json.NewDecoder(r.Body).Decode(&got))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	driver := NewDefaultDriver(server.Client())
	_, err := driver.Send(context.Background(), server.URL, "tg-alice", TriggerPayload{Text: "hi"})
	require.NoError(t, err)
	assert.Equal(t, "hi", got.Text)
}
```

- [ ] **Step 2: Run it — expect a compile error (Send has new signature).**

```bash
cd go && go test ./internal/trigger/ -run TestDefaultDriver_AcceptsTenantIdButIgnoresIt -count=1 2>&1 | tail -5
```
Expected: build failure — too many arguments / method signature mismatch.

- [ ] **Step 3: Update the Driver interface and DefaultDriver.**

In `go/internal/trigger/driver.go`:

```go
type Driver interface {
	Send(ctx context.Context, endpoint, tenantId string, payload TriggerPayload) (any, error)
}
```

and `DefaultDriver.Send`:

```go
func (d *DefaultDriver) Send(ctx context.Context, endpoint, _ string, payload TriggerPayload) (any, error) {
	// ... existing body, no other changes ...
}
```

- [ ] **Step 4: Fix the only call site.**

In `go/internal/trigger/gateway.go`, inside `buildHandler`'s closure, change:

```go
result, err := driver.Send(ctx, endpoint, payload)
```

to:

```go
result, err := driver.Send(ctx, endpoint, tenantId, payload)
```

- [ ] **Step 5: Update the existing `TestDefaultDriver_SendsPayload` and `TestDefaultDriver_HandlesErrorResponse` tests.**

Find both tests in `go/internal/trigger/gateway_test.go` and change their `driver.Send(context.Background(), server.URL, payload)` calls to `driver.Send(context.Background(), server.URL, "", payload)`.

- [ ] **Step 6: Run all trigger tests.**

```bash
cd go && go test ./internal/trigger/ -count=1
```
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add go/internal/trigger/driver.go go/internal/trigger/gateway.go go/internal/trigger/gateway_test.go
git commit -m "refactor(trigger): add tenantId to Driver.Send signature"
```

---

## Task 4: misconfiguredDriver helper

A tiny driver that fails every `Send` with a provided reason. Mirrors `APIGuard.misconfigured`.

**Files:**
- Modify: `go/internal/trigger/driver.go`
- Create: test inline in existing `go/internal/trigger/gateway_test.go` or a new `driver_test.go` — use `driver_test.go` to keep files focused.
- Create: `go/internal/trigger/driver_test.go`

- [ ] **Step 1: Write failing test.**

Create `go/internal/trigger/driver_test.go`:

```go
package trigger

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMisconfiguredDriver_AlwaysFails(t *testing.T) {
	drv := &misconfiguredDriver{reason: "no url"}

	_, err := drv.Send(context.Background(), "http://anything", "tg-alice", TriggerPayload{Text: "hi"})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "driver misconfigured")
	assert.Contains(t, err.Error(), "no url")
}
```

- [ ] **Step 2: Run — expect unresolved type.**

```bash
cd go && go test ./internal/trigger/ -run TestMisconfiguredDriver -count=1 2>&1 | tail -5
```
Expected: undefined: `misconfiguredDriver`.

- [ ] **Step 3: Add the type.**

Append to `go/internal/trigger/driver.go`:

```go
// misconfiguredDriver denies every event with a fixed reason. Used when
// buildDriver cannot construct a usable driver (unknown name, unresolvable
// secret). Consistent with APIGuard's misconfigured state.
type misconfiguredDriver struct {
	reason string
}

func (d *misconfiguredDriver) Send(_ context.Context, _ string, _ string, _ TriggerPayload) (any, error) {
	return nil, fmt.Errorf("driver misconfigured: %s", d.reason)
}
```

Ensure `fmt` is imported in `driver.go` (it already is).

- [ ] **Step 4: Run test — expect PASS.**

```bash
cd go && go test ./internal/trigger/ -run TestMisconfiguredDriver -count=1
```

- [ ] **Step 5: Commit.**

```bash
git add go/internal/trigger/driver.go go/internal/trigger/driver_test.go
git commit -m "feat(trigger): add misconfiguredDriver"
```

---

## Task 5: Plugin registry (with injectable loader for testability)

The registry owns plugin lifecycle. Tests use a fake loader; end-to-end tests with real subprocesses come later (Task 9).

**Files:**
- Create: `go/internal/trigger/plugin_registry.go`
- Create: `go/internal/trigger/plugin_registry_test.go`

- [ ] **Step 1: Write failing tests — they exercise a fake loader.**

Create `go/internal/trigger/plugin_registry_test.go`:

```go
package trigger

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/zdavison/boilerhouse/go/pkg/driverplugin"
)

// fakeLoadedDriver is a stand-in for a real gRPC-backed plugin driver.
type fakeLoadedDriver struct {
	name        string
	killed      bool
	nameErr     error
}

func (f *fakeLoadedDriver) Name(_ context.Context) (string, error) {
	return f.name, f.nameErr
}
func (f *fakeLoadedDriver) Send(_ context.Context, _ driverplugin.SendRequest) (driverplugin.SendResponse, error) {
	return driverplugin.SendResponse{Text: "ok"}, nil
}
func (f *fakeLoadedDriver) Kill() { f.killed = true }

// fakeLoader is an injectable loader that produces fakeLoadedDriver instances
// without spawning subprocesses.
type fakeLoader struct {
	// nameByPath maps binary path → declared name. Absence means "simulate handshake failure".
	nameByPath map[string]string
	// errByPath maps binary path → synthetic load error.
	errByPath map[string]error
}

func (l *fakeLoader) load(_ context.Context, path string) (pluginHandle, error) {
	if err, ok := l.errByPath[path]; ok {
		return nil, err
	}
	name, ok := l.nameByPath[path]
	if !ok {
		return nil, errors.New("handshake failed: magic cookie mismatch")
	}
	return &fakeLoadedDriver{name: name}, nil
}

// helper: build a dir with empty "executable" files.
func tempPluginDir(t *testing.T, names ...string) string {
	t.Helper()
	dir := t.TempDir()
	for _, n := range names {
		path := filepath.Join(dir, n)
		require.NoError(t, os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755))
	}
	return dir
}

func TestRegistry_LoadsPlugins(t *testing.T) {
	dir := tempPluginDir(t, "claude-code", "openclaw")

	loader := &fakeLoader{nameByPath: map[string]string{
		filepath.Join(dir, "claude-code"): "claude-code",
		filepath.Join(dir, "openclaw"):    "openclaw",
	}}
	reg, err := newPluginRegistry(context.Background(), dir, loader, nil)
	require.NoError(t, err)
	defer reg.Close()

	_, ok := reg.Driver("claude-code")
	assert.True(t, ok)
	_, ok = reg.Driver("openclaw")
	assert.True(t, ok)
	_, ok = reg.Driver("missing")
	assert.False(t, ok)

	states := reg.State()
	assert.Len(t, states, 2)
	for _, s := range states {
		assert.Equal(t, "loaded", s.Status)
		assert.Empty(t, s.Error)
		assert.Equal(t, "driver", s.Kind)
	}
}

func TestRegistry_RecordsLoadErrors(t *testing.T) {
	dir := tempPluginDir(t, "broken")

	loader := &fakeLoader{errByPath: map[string]error{
		filepath.Join(dir, "broken"): errors.New("handshake failed: wrong magic cookie"),
	}}
	reg, err := newPluginRegistry(context.Background(), dir, loader, nil)
	require.NoError(t, err)
	defer reg.Close()

	states := reg.State()
	require.Len(t, states, 1)
	assert.Equal(t, "error", states[0].Status)
	assert.Contains(t, states[0].Error, "handshake failed")
	assert.Empty(t, states[0].Name)
	assert.Equal(t, filepath.Join(dir, "broken"), states[0].Binary)
}

func TestRegistry_DuplicateNameKillsSecond(t *testing.T) {
	dir := tempPluginDir(t, "plugin-a", "plugin-b")

	loader := &fakeLoader{nameByPath: map[string]string{
		filepath.Join(dir, "plugin-a"): "same-name",
		filepath.Join(dir, "plugin-b"): "same-name",
	}}
	reg, err := newPluginRegistry(context.Background(), dir, loader, nil)
	require.NoError(t, err)
	defer reg.Close()

	// Exactly one "loaded" and one "error" (the duplicate).
	var loaded, errored int
	for _, s := range reg.State() {
		switch s.Status {
		case "loaded":
			loaded++
		case "error":
			errored++
			assert.Contains(t, s.Error, "duplicate")
		}
	}
	assert.Equal(t, 1, loaded)
	assert.Equal(t, 1, errored)
}

func TestRegistry_IgnoresNonExecutableFiles(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "readme.txt"), []byte("hi"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "plugin"), []byte("#!/bin/sh\n"), 0o755))

	loader := &fakeLoader{nameByPath: map[string]string{
		filepath.Join(dir, "plugin"): "plugin",
	}}
	reg, err := newPluginRegistry(context.Background(), dir, loader, nil)
	require.NoError(t, err)
	defer reg.Close()

	states := reg.State()
	assert.Len(t, states, 1) // readme.txt was skipped
	assert.Equal(t, "plugin", states[0].Name)
}

func TestRegistry_CloseKillsLoadedPlugins(t *testing.T) {
	dir := tempPluginDir(t, "p1", "p2")

	handle1 := &fakeLoadedDriver{name: "p1"}
	handle2 := &fakeLoadedDriver{name: "p2"}
	loader := &loaderFn{fn: func(_ context.Context, path string) (pluginHandle, error) {
		switch filepath.Base(path) {
		case "p1":
			return handle1, nil
		case "p2":
			return handle2, nil
		}
		return nil, errors.New("unexpected path")
	}}

	reg, err := newPluginRegistry(context.Background(), dir, loader, nil)
	require.NoError(t, err)

	require.NoError(t, reg.Close())
	assert.True(t, handle1.killed)
	assert.True(t, handle2.killed)
}

// loaderFn adapts an inline function to the loader interface.
type loaderFn struct {
	fn func(ctx context.Context, path string) (pluginHandle, error)
}

func (l *loaderFn) load(ctx context.Context, path string) (pluginHandle, error) {
	return l.fn(ctx, path)
}
```

- [ ] **Step 2: Run — expect multiple undefined symbols.**

```bash
cd go && go test ./internal/trigger/ -run TestRegistry -count=1 2>&1 | tail -20
```
Expected: undefined: `newPluginRegistry`, `pluginHandle`, etc.

- [ ] **Step 3: Implement the registry.**

Create `go/internal/trigger/plugin_registry.go`:

```go
package trigger

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/zdavison/boilerhouse/go/pkg/driverplugin"
)

// pluginHandle is the abstraction over a loaded plugin — an in-process gRPC
// client plus a Kill handle for lifecycle. Wrapped for testability; the real
// implementation uses hashicorp/go-plugin under the hood (Task 9).
type pluginHandle interface {
	Name(ctx context.Context) (string, error)
	Send(ctx context.Context, req driverplugin.SendRequest) (driverplugin.SendResponse, error)
	Kill()
}

// pluginLoader spawns a plugin binary and returns a usable handle.
type pluginLoader interface {
	load(ctx context.Context, path string) (pluginHandle, error)
}

// loadedPlugin is an internal registry entry.
type loadedPlugin struct {
	name     string
	binary   string
	handle   pluginHandle
	loadedAt time.Time
}

// PluginState is the public, JSON-serializable view of registry state.
type PluginState struct {
	Name     string    `json:"name,omitempty"`
	Kind     string    `json:"kind"`
	Binary   string    `json:"binary"`
	Status   string    `json:"status"`
	Error    string    `json:"error,omitempty"`
	LoadedAt time.Time `json:"loadedAt,omitempty"`
	FailedAt time.Time `json:"failedAt,omitempty"`
}

// PluginRegistry is implemented by pluginRegistry; the interface lives alongside
// the impl to keep this file focused.
type PluginRegistry interface {
	Driver(name string) (Driver, bool)
	State() []PluginState
	Close() error
}

type pluginRegistry struct {
	mu      sync.Mutex
	byName  map[string]*loadedPlugin
	results []PluginState // one per binary scanned, in stable order
	log     *slog.Logger
}

// newPluginRegistry scans dir, attempts to load every executable file via
// loader, and returns the resulting registry. Individual load failures do not
// cause this function to return an error — they show up as error entries in
// State(). Only truly unexpected errors (e.g. dir ENOENT) return an error.
func newPluginRegistry(ctx context.Context, dir string, loader pluginLoader, log *slog.Logger) (*pluginRegistry, error) {
	if log == nil {
		log = slog.Default()
	}
	r := &pluginRegistry{
		byName: make(map[string]*loadedPlugin),
		log:    log,
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			// No plugin dir = empty registry. Fine.
			return r, nil
		}
		return nil, fmt.Errorf("read plugin dir: %w", err)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })

	for _, entry := range entries {
		if !entry.Type().IsRegular() {
			continue
		}
		path := filepath.Join(dir, entry.Name())

		info, err := os.Stat(path)
		if err != nil || info.Mode()&0o111 == 0 {
			continue // not executable
		}

		r.loadOne(ctx, path, loader)
	}

	return r, nil
}

func (r *pluginRegistry) loadOne(ctx context.Context, path string, loader pluginLoader) {
	handle, err := loader.load(ctx, path)
	if err != nil {
		r.log.Warn("plugin load failed", "binary", path, "error", err)
		r.results = append(r.results, PluginState{
			Kind:     "driver",
			Binary:   path,
			Status:   "error",
			Error:    err.Error(),
			FailedAt: time.Now().UTC(),
		})
		return
	}

	name, err := handle.Name(ctx)
	if err != nil {
		r.log.Warn("plugin name lookup failed", "binary", path, "error", err)
		handle.Kill()
		r.results = append(r.results, PluginState{
			Kind:     "driver",
			Binary:   path,
			Status:   "error",
			Error:    fmt.Sprintf("name lookup: %s", err),
			FailedAt: time.Now().UTC(),
		})
		return
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	if _, dup := r.byName[name]; dup {
		r.log.Warn("plugin duplicate name", "binary", path, "name", name)
		handle.Kill()
		r.results = append(r.results, PluginState{
			Kind:     "driver",
			Binary:   path,
			Status:   "error",
			Error:    fmt.Sprintf("duplicate driver name %q (first registered wins)", name),
			FailedAt: time.Now().UTC(),
		})
		return
	}

	loadedAt := time.Now().UTC()
	r.byName[name] = &loadedPlugin{
		name:     name,
		binary:   path,
		handle:   handle,
		loadedAt: loadedAt,
	}
	r.results = append(r.results, PluginState{
		Name:     name,
		Kind:     "driver",
		Binary:   path,
		Status:   "loaded",
		LoadedAt: loadedAt,
	})
	r.log.Info("plugin loaded", "name", name, "binary", path)
}

// Driver returns a Driver backed by the named plugin, or (nil, false) if the
// plugin isn't loaded.
func (r *pluginRegistry) Driver(name string) (Driver, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	lp, ok := r.byName[name]
	if !ok {
		return nil, false
	}
	return &pluginDriver{handle: lp.handle}, true
}

// State returns a snapshot of the registry state, in load order.
func (r *pluginRegistry) State() []PluginState {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]PluginState, len(r.results))
	copy(out, r.results)
	return out
}

// Close kills every loaded plugin subprocess.
func (r *pluginRegistry) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, lp := range r.byName {
		lp.handle.Kill()
	}
	r.byName = nil
	return nil
}

// pluginDriver adapts a pluginHandle to the Driver interface.
type pluginDriver struct {
	handle pluginHandle
	// options and optErr are set by resolveOptionsForPlugin; for bare
	// pluginDriver values (from registry.Driver alone), options is empty.
	options []byte
}

func (d *pluginDriver) Send(ctx context.Context, endpoint, tenantId string, payload TriggerPayload) (any, error) {
	req := driverplugin.SendRequest{
		Endpoint: endpoint,
		TenantId: tenantId,
		Payload: driverplugin.TriggerPayload{
			Text:   payload.Text,
			Source: payload.Source,
			Raw:    payload.Raw,
		},
		Options: d.options,
	}
	resp, err := d.handle.Send(ctx, req)
	if err != nil {
		return nil, err
	}
	if resp.Raw != nil {
		return resp.Raw, nil
	}
	if resp.Text != "" {
		return map[string]any{"text": resp.Text}, nil
	}
	return nil, nil
}
```

- [ ] **Step 4: Run tests.**

```bash
cd go && go test ./internal/trigger/ -run TestRegistry -count=1 -v
```
Expected: all five tests PASS.

- [ ] **Step 5: Commit.**

```bash
git add go/internal/trigger/plugin_registry.go go/internal/trigger/plugin_registry_test.go
git commit -m "feat(trigger): add plugin registry with injectable loader"
```

---

## Task 6: Plugin state HTTP listener

Read-only `GET /plugins` served by the trigger gateway.

**Files:**
- Create: `go/internal/trigger/plugins_http.go`
- Create: `go/internal/trigger/plugins_http_test.go`

- [ ] **Step 1: Write failing test.**

Create `go/internal/trigger/plugins_http_test.go`:

```go
package trigger

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// stubRegistry returns canned state. Used to isolate the HTTP handler from the
// rest of the registry.
type stubRegistry struct {
	states []PluginState
}

func (s *stubRegistry) Driver(_ string) (Driver, bool) { return nil, false }
func (s *stubRegistry) State() []PluginState            { return s.states }
func (s *stubRegistry) Close() error                    { return nil }

func TestPluginsHTTP_ServesState(t *testing.T) {
	reg := &stubRegistry{states: []PluginState{
		{Name: "claude-code", Kind: "driver", Binary: "/plugins/drivers/claude-code", Status: "loaded", LoadedAt: time.Unix(1700000000, 0).UTC()},
		{Kind: "driver", Binary: "/plugins/drivers/broken", Status: "error", Error: "handshake failed", FailedAt: time.Unix(1700000001, 0).UTC()},
	}}

	lis, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	errCh := make(chan error, 1)
	go func() { errCh <- servePluginsHTTP(ctx, lis, reg, nil) }()

	resp, err := http.Get("http://" + lis.Addr().String() + "/plugins")
	require.NoError(t, err)
	defer resp.Body.Close()

	assert.Equal(t, http.StatusOK, resp.StatusCode)
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)

	var parsed struct {
		Plugins []PluginState `json:"plugins"`
	}
	require.NoError(t, json.Unmarshal(body, &parsed))
	require.Len(t, parsed.Plugins, 2)
	assert.Equal(t, "claude-code", parsed.Plugins[0].Name)
	assert.Equal(t, "error", parsed.Plugins[1].Status)
	assert.Equal(t, "handshake failed", parsed.Plugins[1].Error)

	cancel()
	select {
	case err := <-errCh:
		assert.NoError(t, err)
	case <-time.After(2 * time.Second):
		t.Fatal("server did not shut down")
	}
}
```

- [ ] **Step 2: Run — expect undefined function.**

```bash
cd go && go test ./internal/trigger/ -run TestPluginsHTTP -count=1 2>&1 | tail -5
```

- [ ] **Step 3: Implement.**

Create `go/internal/trigger/plugins_http.go`:

```go
package trigger

import (
	"context"
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"time"
)

// servePluginsHTTP runs a read-only HTTP server exposing GET /plugins.
// Blocks until ctx is cancelled.
func servePluginsHTTP(ctx context.Context, lis net.Listener, reg PluginRegistry, log *slog.Logger) error {
	if log == nil {
		log = slog.Default()
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/plugins", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"plugins": reg.State()})
	})

	srv := &http.Server{
		Handler:      mux,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 5 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	log.Info("plugins http listener started", "addr", lis.Addr().String())
	if err := srv.Serve(lis); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}
```

- [ ] **Step 4: Run test.**

```bash
cd go && go test ./internal/trigger/ -run TestPluginsHTTP -count=1 -v
```
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add go/internal/trigger/plugins_http.go go/internal/trigger/plugins_http_test.go
git commit -m "feat(trigger): add plugin state HTTP listener"
```

---

## Task 7: Telegram adapter — botTokenSecretRef

Independent of plugins. Gateway-side Secret resolution.

**Files:**
- Modify: `go/internal/trigger/adapter_telegram.go`
- Modify: `go/internal/trigger/gateway.go`
- Create: test cases in `go/internal/trigger/adapter_telegram_test.go` (exists) — append new tests
- Create: test cases in `go/internal/trigger/gateway_test.go` — append

- [ ] **Step 1: Write failing tests.**

Append to `go/internal/trigger/adapter_telegram_test.go`:

```go
func TestParseTelegramConfig_RejectsBothTokenAndSecretRef(t *testing.T) {
	_, err := parseTelegramConfig(map[string]any{
		"botToken":          "literal",
		"botTokenSecretRef": map[string]any{"name": "s", "key": "token"},
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "mutually exclusive")
}

func TestParseTelegramConfig_RequiresOneOfTokenOrSecretRef(t *testing.T) {
	_, err := parseTelegramConfig(map[string]any{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "botToken")
}

func TestParseTelegramConfig_ParsesSecretRef(t *testing.T) {
	cfg, err := parseTelegramConfig(map[string]any{
		"botTokenSecretRef": map[string]any{"name": "tg-secret", "key": "token"},
	})
	require.NoError(t, err)
	require.NotNil(t, cfg.BotTokenSecretRef)
	assert.Equal(t, "tg-secret", cfg.BotTokenSecretRef.Name)
	assert.Equal(t, "token", cfg.BotTokenSecretRef.Key)
	assert.Empty(t, cfg.BotToken)
}
```

Append to `go/internal/trigger/gateway_test.go` (requires `corev1`, `metav1`, `fake` imports already present from guard_api_test.go — if not, add them):

```go
func TestBuildAdapter_ResolvesTelegramBotTokenSecretRef(t *testing.T) {
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "tg-secret", Namespace: "ns"},
		Data:       map[string][]byte{"token": []byte("12345:ABCDEF")},
	}
	k8sClient := fake.NewClientBuilder().WithObjects(secret).Build()
	gw := NewGateway(k8sClient, "ns", nil)

	cfgJSON, err := json.Marshal(map[string]any{
		"botTokenSecretRef": map[string]any{"name": "tg-secret", "key": "token"},
	})
	require.NoError(t, err)

	trig := &v1alpha1.BoilerhouseTrigger{
		ObjectMeta: metav1.ObjectMeta{Name: "t", Namespace: "ns"},
		Spec: v1alpha1.BoilerhouseTriggerSpec{
			Type:        "telegram",
			WorkloadRef: "wl",
			Config:      &runtime.RawExtension{Raw: cfgJSON},
		},
	}

	adapter, err := gw.buildAdapter(context.Background(), trig)
	require.NoError(t, err)
	ta, ok := adapter.(*TelegramAdapter)
	require.True(t, ok)
	assert.Equal(t, "12345:ABCDEF", ta.config["botToken"])
}

func TestBuildAdapter_FailsWhenTelegramSecretMissing(t *testing.T) {
	k8sClient := fake.NewClientBuilder().Build()
	gw := NewGateway(k8sClient, "ns", nil)

	cfgJSON, err := json.Marshal(map[string]any{
		"botTokenSecretRef": map[string]any{"name": "missing", "key": "token"},
	})
	require.NoError(t, err)

	trig := &v1alpha1.BoilerhouseTrigger{
		ObjectMeta: metav1.ObjectMeta{Name: "t", Namespace: "ns"},
		Spec: v1alpha1.BoilerhouseTriggerSpec{
			Type:        "telegram",
			WorkloadRef: "wl",
			Config:      &runtime.RawExtension{Raw: cfgJSON},
		},
	}

	_, err = gw.buildAdapter(context.Background(), trig)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "telegram bot token secret")
}
```

- [ ] **Step 2: Run — expect failures/compile errors.**

```bash
cd go && go test ./internal/trigger/ -run 'TestParseTelegramConfig_Rejects|TestParseTelegramConfig_Requires|TestParseTelegramConfig_ParsesSecretRef|TestBuildAdapter_Resolves|TestBuildAdapter_Fails' -count=1 2>&1 | tail -20
```

- [ ] **Step 3: Update `telegramConfig` and `parseTelegramConfig`.**

In `go/internal/trigger/adapter_telegram.go`, change the struct and the parser:

```go
type telegramConfig struct {
	BotToken           string
	BotTokenSecretRef  *telegramSecretRef
	UpdateTypes        []string
	PollTimeoutSeconds int
	APIBaseURL         string
}

type telegramSecretRef struct {
	Name string `json:"name"`
	Key  string `json:"key"`
}

func parseTelegramConfig(raw map[string]any) (telegramConfig, error) {
	cfg := telegramConfig{
		UpdateTypes:        []string{"message"},
		PollTimeoutSeconds: defaultTelegramPollTimeout,
		APIBaseURL:         defaultTelegramAPIBaseURL,
	}

	if raw == nil {
		return cfg, fmt.Errorf("telegram adapter: config is required")
	}

	hasLiteral := false
	if v, ok := raw["botToken"].(string); ok && v != "" {
		cfg.BotToken = v
		hasLiteral = true
	}

	hasRef := false
	if v, ok := raw["botTokenSecretRef"].(map[string]any); ok {
		name, _ := v["name"].(string)
		key, _ := v["key"].(string)
		if name == "" || key == "" {
			return cfg, fmt.Errorf("telegram adapter: botTokenSecretRef requires name and key")
		}
		cfg.BotTokenSecretRef = &telegramSecretRef{Name: name, Key: key}
		hasRef = true
	}

	switch {
	case hasLiteral && hasRef:
		return cfg, fmt.Errorf("telegram adapter: botToken and botTokenSecretRef are mutually exclusive")
	case !hasLiteral && !hasRef:
		return cfg, fmt.Errorf("telegram adapter: botToken or botTokenSecretRef is required")
	}

	if v, ok := raw["apiBaseUrl"].(string); ok && v != "" {
		cfg.APIBaseURL = v
	}

	if v, ok := raw["pollTimeoutSeconds"]; ok {
		switch n := v.(type) {
		case int:
			cfg.PollTimeoutSeconds = n
		case int64:
			cfg.PollTimeoutSeconds = int(n)
		case float64:
			cfg.PollTimeoutSeconds = int(n)
		}
	}

	if v, ok := raw["updateTypes"]; ok {
		switch typed := v.(type) {
		case []string:
			if len(typed) > 0 {
				cfg.UpdateTypes = typed
			}
		case []any:
			var types []string
			for _, item := range typed {
				if s, ok := item.(string); ok {
					types = append(types, s)
				}
			}
			if len(types) > 0 {
				cfg.UpdateTypes = types
			}
		}
	}

	return cfg, nil
}
```

- [ ] **Step 4: Resolve the Secret in `buildAdapter`.**

In `go/internal/trigger/gateway.go`, change `buildAdapter` to take `ctx`, resolve the Secret for the telegram case, and pass a resolved-token config map to `NewTelegramAdapter`. Replace the existing method:

```go
func (g *Gateway) buildAdapter(ctx context.Context, trigger *v1alpha1.BoilerhouseTrigger) (Adapter, error) {
	switch trigger.Spec.Type {
	case "webhook":
		cfg := parseWebhookConfig(trigger)
		return NewWebhookAdapter(cfg.Path, cfg.ListenAddr), nil
	case "cron":
		cfg := parseCronConfig(trigger)
		interval, err := time.ParseDuration(cfg.Interval)
		if err != nil {
			return nil, fmt.Errorf("invalid cron interval %q: %w", cfg.Interval, err)
		}
		return NewCronAdapter(interval, cfg.Payload), nil
	case "telegram":
		rawMap := parseTelegramAdapterConfig(trigger)

		// Validate + normalize by running the full parser.
		parsed, err := parseTelegramConfig(rawMap)
		if err != nil {
			return nil, err
		}

		// Resolve secretRef if present, substituting the token into rawMap.
		if parsed.BotTokenSecretRef != nil {
			var secret corev1.Secret
			err := g.client.Get(ctx, types.NamespacedName{
				Name:      parsed.BotTokenSecretRef.Name,
				Namespace: g.namespace,
			}, &secret)
			if err != nil {
				return nil, fmt.Errorf("telegram bot token secret: %w", err)
			}
			tokenBytes, ok := secret.Data[parsed.BotTokenSecretRef.Key]
			if !ok {
				return nil, fmt.Errorf("telegram bot token secret: key %q not found in %q", parsed.BotTokenSecretRef.Key, parsed.BotTokenSecretRef.Name)
			}
			rawMap["botToken"] = string(tokenBytes)
			delete(rawMap, "botTokenSecretRef")
		}

		return NewTelegramAdapter(rawMap), nil
	default:
		return nil, fmt.Errorf("unsupported trigger type: %s", trigger.Spec.Type)
	}
}
```

Ensure the `corev1` and `types` imports are present in `gateway.go` (add them if not):

```go
corev1 "k8s.io/api/core/v1"
"k8s.io/apimachinery/pkg/types"
```

- [ ] **Step 5: Update the call site in `syncOnce`.**

Change:

```go
adapter, err := g.buildAdapter(trigger)
```

to:

```go
adapter, err := g.buildAdapter(ctx, trigger)
```

- [ ] **Step 6: Run the telegram + adapter tests.**

```bash
cd go && go test ./internal/trigger/ -run 'Telegram|BuildAdapter' -count=1 -v
```
Expected: all PASS.

- [ ] **Step 7: Run full trigger package.**

```bash
cd go && go test ./internal/trigger/ -count=1
```
Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add go/internal/trigger/adapter_telegram.go go/internal/trigger/adapter_telegram_test.go go/internal/trigger/gateway.go go/internal/trigger/gateway_test.go
git commit -m "feat(trigger): telegram adapter supports botTokenSecretRef"
```

---

## Task 8: Gateway buildDriver + options resolution

Wire plugins into the event pipeline. Requires the registry (Task 5) and the pluginDriver/misconfiguredDriver (Tasks 4, 5).

**Files:**
- Modify: `go/internal/trigger/gateway.go`
- Create: test cases in `go/internal/trigger/gateway_test.go`

- [ ] **Step 1: Write failing tests.**

Append to `go/internal/trigger/gateway_test.go`:

```go
// fakeRegistry is a PluginRegistry that returns a canned driver by name.
type fakeRegistry struct {
	drivers map[string]Driver
	states  []PluginState
}

func (r *fakeRegistry) Driver(name string) (Driver, bool) {
	d, ok := r.drivers[name]
	return d, ok
}
func (r *fakeRegistry) State() []PluginState { return r.states }
func (r *fakeRegistry) Close() error         { return nil }

func TestBuildDriver_UnknownNameReturnsMisconfigured(t *testing.T) {
	gw := NewGateway(fake.NewClientBuilder().Build(), "ns", nil)
	gw.plugins = &fakeRegistry{drivers: map[string]Driver{}}

	trig := &v1alpha1.BoilerhouseTrigger{
		Spec: v1alpha1.BoilerhouseTriggerSpec{Driver: "missing"},
	}
	drv := gw.buildDriver(context.Background(), trig)
	_, err := drv.Send(context.Background(), "http://x", "t", TriggerPayload{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "driver misconfigured")
	assert.Contains(t, err.Error(), `"missing"`)
}

func TestBuildDriver_EmptyNameReturnsDefault(t *testing.T) {
	gw := NewGateway(fake.NewClientBuilder().Build(), "ns", nil)
	gw.plugins = &fakeRegistry{drivers: map[string]Driver{}}

	trig := &v1alpha1.BoilerhouseTrigger{
		Spec: v1alpha1.BoilerhouseTriggerSpec{Driver: ""},
	}
	drv := gw.buildDriver(context.Background(), trig)
	_, ok := drv.(*DefaultDriver)
	assert.True(t, ok)
}

func TestBuildDriver_PluginDriverSendsResolvedOptions(t *testing.T) {
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "oc", Namespace: "ns"},
		Data:       map[string][]byte{"token": []byte("sek")},
	}
	k8sClient := fake.NewClientBuilder().WithObjects(secret).Build()

	fakeHandle := &fakeLoadedDriver{name: "openclaw"}
	pluginDrv := &pluginDriver{handle: fakeHandle}

	gw := NewGateway(k8sClient, "ns", nil)
	gw.plugins = &fakeRegistry{drivers: map[string]Driver{"openclaw": pluginDrv}}

	optsJSON, err := json.Marshal(map[string]any{
		"gatewayTokenSecretRef": map[string]any{"name": "oc", "key": "token"},
	})
	require.NoError(t, err)

	trig := &v1alpha1.BoilerhouseTrigger{
		ObjectMeta: metav1.ObjectMeta{Name: "t", Namespace: "ns"},
		Spec: v1alpha1.BoilerhouseTriggerSpec{
			Driver:        "openclaw",
			DriverOptions: &runtime.RawExtension{Raw: optsJSON},
		},
	}

	drv := gw.buildDriver(context.Background(), trig)
	wrapped, ok := drv.(*pluginDriver)
	require.True(t, ok, "expected *pluginDriver, got %T", drv)

	// The wrapper must carry a resolved-options JSON with gatewayToken set.
	require.NotEmpty(t, wrapped.options)
	var parsed map[string]any
	require.NoError(t, json.Unmarshal(wrapped.options, &parsed))
	assert.Equal(t, "sek", parsed["gatewayToken"])
	_, hasRef := parsed["gatewayTokenSecretRef"]
	assert.False(t, hasRef, "gatewayTokenSecretRef should be removed after resolution")
}

func TestBuildDriver_MissingOpenclawSecretReturnsMisconfigured(t *testing.T) {
	k8sClient := fake.NewClientBuilder().Build()
	pluginDrv := &pluginDriver{handle: &fakeLoadedDriver{name: "openclaw"}}

	gw := NewGateway(k8sClient, "ns", nil)
	gw.plugins = &fakeRegistry{drivers: map[string]Driver{"openclaw": pluginDrv}}

	optsJSON, _ := json.Marshal(map[string]any{
		"gatewayTokenSecretRef": map[string]any{"name": "missing", "key": "token"},
	})
	trig := &v1alpha1.BoilerhouseTrigger{
		ObjectMeta: metav1.ObjectMeta{Name: "t", Namespace: "ns"},
		Spec: v1alpha1.BoilerhouseTriggerSpec{
			Driver:        "openclaw",
			DriverOptions: &runtime.RawExtension{Raw: optsJSON},
		},
	}

	drv := gw.buildDriver(context.Background(), trig)
	_, err := drv.Send(context.Background(), "http://x", "t", TriggerPayload{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "driver misconfigured")
}
```

- [ ] **Step 2: Run — expect compile errors for missing `gw.plugins` field and `buildDriver` method.**

```bash
cd go && go test ./internal/trigger/ -run TestBuildDriver -count=1 2>&1 | tail -10
```

- [ ] **Step 3: Add `plugins` field to `Gateway` and update the constructor.**

In `go/internal/trigger/gateway.go`, update:

```go
type Gateway struct {
	client    client.Client
	namespace string
	adapters  map[string]runningAdapter
	mu        sync.Mutex
	log       *slog.Logger
	plugins   PluginRegistry
}

func NewGateway(k8sClient client.Client, namespace string, log *slog.Logger) *Gateway {
	// existing body plus:
	return &Gateway{
		client:    k8sClient,
		namespace: namespace,
		adapters:  make(map[string]runningAdapter),
		log:       log,
		plugins:   &emptyRegistry{},
	}
}

// emptyRegistry is the zero-value registry — no plugins loaded.
type emptyRegistry struct{}

func (emptyRegistry) Driver(_ string) (Driver, bool) { return nil, false }
func (emptyRegistry) State() []PluginState            { return nil }
func (emptyRegistry) Close() error                    { return nil }

// SetPluginRegistry injects a registry after construction. Callers in
// production wire this up in main(); tests may override directly.
func (g *Gateway) SetPluginRegistry(reg PluginRegistry) {
	g.plugins = reg
}
```

Leave `nil`-check at the top of the constructor body intact.

- [ ] **Step 4: Add `buildDriver` and `resolveOptionsForPlugin`.**

Append to `go/internal/trigger/gateway.go`:

```go
// buildDriver resolves the driver for a trigger, applying any options
// resolution (e.g. secretRef → literal). Always returns a usable Driver;
// on failure returns a misconfiguredDriver whose Send reports the reason.
func (g *Gateway) buildDriver(ctx context.Context, trigger *v1alpha1.BoilerhouseTrigger) Driver {
	switch trigger.Spec.Driver {
	case "", "default":
		return NewDefaultDriver(nil)
	}

	base, ok := g.plugins.Driver(trigger.Spec.Driver)
	if !ok {
		return &misconfiguredDriver{reason: fmt.Sprintf("driver %q not loaded", trigger.Spec.Driver)}
	}

	return g.resolveOptionsForPlugin(ctx, trigger, base)
}

// resolveOptionsForPlugin resolves known *SecretRef fields in DriverOptions
// against the K8s client, substituting literal values. Returns a misconfigured
// driver if any referenced Secret cannot be resolved. If the base driver is a
// *pluginDriver, the returned driver is a new *pluginDriver carrying the
// resolved options. Otherwise the base driver is returned unchanged.
func (g *Gateway) resolveOptionsForPlugin(ctx context.Context, trigger *v1alpha1.BoilerhouseTrigger, base Driver) Driver {
	var opts map[string]any
	if trigger.Spec.DriverOptions != nil && trigger.Spec.DriverOptions.Raw != nil {
		if err := json.Unmarshal(trigger.Spec.DriverOptions.Raw, &opts); err != nil {
			return &misconfiguredDriver{reason: fmt.Sprintf("driverOptions parse: %s", err)}
		}
	}
	if opts == nil {
		opts = map[string]any{}
	}

	// Known secretRef fields: "gatewayTokenSecretRef" → "gatewayToken".
	// Add new (field, literal) pairs here as more drivers need them.
	secretRefs := map[string]string{
		"gatewayTokenSecretRef": "gatewayToken",
	}
	for refKey, litKey := range secretRefs {
		ref, ok := opts[refKey].(map[string]any)
		if !ok {
			continue
		}
		name, _ := ref["name"].(string)
		key, _ := ref["key"].(string)
		if name == "" || key == "" {
			return &misconfiguredDriver{reason: fmt.Sprintf("%s requires name and key", refKey)}
		}

		var secret corev1.Secret
		err := g.client.Get(ctx, types.NamespacedName{Name: name, Namespace: g.namespace}, &secret)
		if err != nil {
			return &misconfiguredDriver{reason: fmt.Sprintf("%s: %s", refKey, err)}
		}
		value, ok := secret.Data[key]
		if !ok {
			return &misconfiguredDriver{reason: fmt.Sprintf("%s: key %q not found in secret %q", refKey, key, name)}
		}
		opts[litKey] = string(value)
		delete(opts, refKey)
	}

	resolved, err := json.Marshal(opts)
	if err != nil {
		return &misconfiguredDriver{reason: fmt.Sprintf("driverOptions re-encode: %s", err)}
	}

	// Only pluginDriver needs carry-through options. Non-plugin drivers
	// (tests mainly) receive base unchanged.
	pd, ok := base.(*pluginDriver)
	if !ok {
		return base
	}
	return &pluginDriver{handle: pd.handle, options: resolved}
}
```

- [ ] **Step 5: Wire into `buildHandler`.**

Replace the existing `driver := NewDefaultDriver(nil)` line in `buildHandler` with:

```go
driver := g.buildDriver(ctx, trigger)
```

- [ ] **Step 6: Run tests.**

```bash
cd go && go test ./internal/trigger/ -run 'TestBuildDriver|TestBuildAdapter|TestParseTelegram|TestAllowlist|TestAPIGuard|TestParseAPIGuard' -count=1
```
Expected: PASS.

- [ ] **Step 7: Run the whole package.**

```bash
cd go && go test ./internal/trigger/ -count=1
```
Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add go/internal/trigger/gateway.go go/internal/trigger/gateway_test.go
git commit -m "feat(trigger): wire driver plugins into buildHandler"
```

---

## Task 9: Real subprocess loader + e2e test

Replace the abstract `pluginLoader` with one backed by `hashicorp/go-plugin`. Add one end-to-end test that builds a fake plugin binary at test time.

**Files:**
- Create: `go/internal/trigger/plugin_loader.go`
- Create: `go/internal/trigger/testdata/fakeplugin/main.go`
- Create: `go/internal/trigger/plugin_e2e_test.go`

- [ ] **Step 1: Implement the real loader.**

Create `go/internal/trigger/plugin_loader.go`:

```go
package trigger

import (
	"context"
	"fmt"
	"log/slog"
	"os/exec"

	"github.com/hashicorp/go-hclog"
	"github.com/hashicorp/go-plugin"

	"github.com/zdavison/boilerhouse/go/pkg/driverplugin"
)

// hashicorpLoader spawns a plugin binary using hashicorp/go-plugin and returns
// a handle backed by the gRPC client.
type hashicorpLoader struct {
	log *slog.Logger
}

func newHashicorpLoader(log *slog.Logger) *hashicorpLoader {
	if log == nil {
		log = slog.Default()
	}
	return &hashicorpLoader{log: log}
}

func (l *hashicorpLoader) load(ctx context.Context, path string) (pluginHandle, error) {
	client := plugin.NewClient(&plugin.ClientConfig{
		HandshakeConfig:  driverplugin.Handshake,
		Plugins:          driverplugin.PluginMap,
		Cmd:              exec.Command(path),
		AllowedProtocols: []plugin.Protocol{plugin.ProtocolGRPC},
		Logger:           hclog.New(&hclog.LoggerOptions{Name: "plugin-" + path, Level: hclog.Info}),
	})

	rpcClient, err := client.Client()
	if err != nil {
		client.Kill()
		return nil, fmt.Errorf("client: %w", err)
	}

	raw, err := rpcClient.Dispense(driverplugin.DispenseKey)
	if err != nil {
		client.Kill()
		return nil, fmt.Errorf("dispense: %w", err)
	}

	plug, ok := raw.(driverplugin.DriverPlugin)
	if !ok {
		client.Kill()
		return nil, fmt.Errorf("dispense: unexpected type %T", raw)
	}

	return &hashicorpHandle{plug: plug, client: client}, nil
}

// hashicorpHandle is a pluginHandle backed by a real subprocess.
type hashicorpHandle struct {
	plug   driverplugin.DriverPlugin
	client *plugin.Client
}

func (h *hashicorpHandle) Name(ctx context.Context) (string, error) {
	return h.plug.Name(ctx)
}
func (h *hashicorpHandle) Send(ctx context.Context, req driverplugin.SendRequest) (driverplugin.SendResponse, error) {
	return h.plug.Send(ctx, req)
}
func (h *hashicorpHandle) Kill() {
	h.client.Kill()
}
```

- [ ] **Step 2: Write a fake plugin binary for the e2e test.**

Create `go/internal/trigger/testdata/fakeplugin/main.go`:

```go
// Fake driver plugin used by plugin_e2e_test.go. Declares name "fake" and
// echoes the prompt text.
package main

import (
	"context"

	"github.com/hashicorp/go-plugin"

	"github.com/zdavison/boilerhouse/go/pkg/driverplugin"
)

type fakeImpl struct{}

func (fakeImpl) Name(_ context.Context) (string, error) { return "fake", nil }
func (fakeImpl) Send(_ context.Context, req driverplugin.SendRequest) (driverplugin.SendResponse, error) {
	return driverplugin.SendResponse{Text: "echo:" + req.Payload.Text}, nil
}

func main() {
	plugin.Serve(&plugin.ServeConfig{
		HandshakeConfig: driverplugin.Handshake,
		Plugins: map[string]plugin.Plugin{
			driverplugin.DispenseKey: &driverplugin.DriverGRPCPlugin{Impl: fakeImpl{}},
		},
		GRPCServer: plugin.DefaultGRPCServer,
	})
}
```

- [ ] **Step 3: Write the e2e test that builds + loads the fake plugin.**

Create `go/internal/trigger/plugin_e2e_test.go`:

```go
package trigger

import (
	"context"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/zdavison/boilerhouse/go/pkg/driverplugin"
)

// TestPluginRegistry_RealSubprocess exercises the full hashicorp/go-plugin
// + gRPC stack by building a tiny plugin binary at test time and loading it.
func TestPluginRegistry_RealSubprocess(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("hashicorp/go-plugin requires unix-like OS for this test")
	}

	tmp := t.TempDir()
	binaryPath := filepath.Join(tmp, "fake")

	// Build the fake plugin binary.
	cmd := exec.Command("go", "build", "-o", binaryPath, "./testdata/fakeplugin")
	cmd.Dir = "." // run from the trigger package dir
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, "go build failed: %s", string(out))

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	loader := newHashicorpLoader(nil)
	reg, err := newPluginRegistry(ctx, tmp, loader, nil)
	require.NoError(t, err)
	defer reg.Close()

	drv, ok := reg.Driver("fake")
	require.True(t, ok, "fake plugin not loaded: %+v", reg.State())

	pd, ok := drv.(*pluginDriver)
	require.True(t, ok)

	resp, err := pd.handle.Send(ctx, driverplugin.SendRequest{
		Endpoint: "http://unused",
		TenantId: "t",
		Payload:  driverplugin.TriggerPayload{Text: "hello"},
	})
	require.NoError(t, err)
	assert.Equal(t, "echo:hello", resp.Text)
}
```

- [ ] **Step 4: Run the e2e test.**

```bash
cd go && go test ./internal/trigger/ -run TestPluginRegistry_RealSubprocess -count=1 -v -timeout 120s
```
Expected: PASS. If it fails, check `go build` output in the error message; `go.mod` must include `hashicorp/go-plugin` and the `driverplugin` package must compile.

- [ ] **Step 5: Commit.**

```bash
git add go/internal/trigger/plugin_loader.go go/internal/trigger/plugin_e2e_test.go go/internal/trigger/testdata/fakeplugin/main.go
git commit -m "feat(trigger): real hashicorp/go-plugin loader + e2e test"
```

---

## Task 10: Wire plugin registry into trigger main.go

Start the registry + HTTP listener from the binary entry point.

**Files:**
- Modify: `go/cmd/trigger/main.go`

- [ ] **Step 1: Update the main function.**

Replace the body of `main` in `go/cmd/trigger/main.go`:

```go
func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	namespace := os.Getenv("K8S_NAMESPACE")
	if namespace == "" {
		namespace = "boilerhouse"
	}

	pluginDir := os.Getenv("BOILERHOUSE_PLUGIN_DIR")
	if pluginDir == "" {
		pluginDir = "/plugins/drivers"
	}

	pluginAddr := os.Getenv("PLUGIN_HTTP_ADDR")
	if pluginAddr == "" {
		pluginAddr = ":8091"
	}

	// Build scheme with core types and Boilerhouse CRDs.
	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		log.Error("failed to add client-go scheme", "error", err)
		os.Exit(1)
	}
	if err := v1alpha1.AddToScheme(scheme); err != nil {
		log.Error("failed to add v1alpha1 scheme", "error", err)
		os.Exit(1)
	}

	// Create K8s client.
	cfg, err := ctrl.GetConfig()
	if err != nil {
		log.Error("failed to get kubeconfig", "error", err)
		os.Exit(1)
	}

	k8sClient, err := client.New(cfg, client.Options{Scheme: scheme})
	if err != nil {
		log.Error("failed to create k8s client", "error", err)
		os.Exit(1)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	// Load plugins at startup.
	loader := trigger.NewHashicorpLoader(log)
	registry, err := trigger.NewPluginRegistry(ctx, pluginDir, loader, log)
	if err != nil {
		log.Error("failed to initialize plugin registry", "error", err)
		os.Exit(1)
	}
	defer registry.Close()

	// Start plugins HTTP listener.
	lis, err := net.Listen("tcp", pluginAddr)
	if err != nil {
		log.Error("failed to bind plugins http", "addr", pluginAddr, "error", err)
		os.Exit(1)
	}
	go func() {
		if err := trigger.ServePluginsHTTP(ctx, lis, registry, log); err != nil {
			log.Error("plugins http listener stopped", "error", err)
		}
	}()

	// Create and run gateway.
	gw := trigger.NewGateway(k8sClient, namespace, log)
	gw.SetPluginRegistry(registry)

	log.Info("starting trigger gateway", "namespace", namespace, "plugin_dir", pluginDir)
	if err := gw.Sync(ctx); err != nil && err != context.Canceled {
		log.Error("trigger gateway exited with error", "error", err)
		os.Exit(1)
	}

	log.Info("trigger gateway stopped")
}
```

Add `"net"` to the import block.

- [ ] **Step 2: Export the constructors from the trigger package.**

The current `newPluginRegistry` and `newHashicorpLoader` are unexported. The binary needs exported constructors.

In `go/internal/trigger/plugin_registry.go`, add at the bottom:

```go
// NewPluginRegistry is the exported entry point used by cmd/trigger/main.go.
func NewPluginRegistry(ctx context.Context, dir string, loader pluginLoader, log *slog.Logger) (PluginRegistry, error) {
	return newPluginRegistry(ctx, dir, loader, log)
}
```

In `go/internal/trigger/plugin_loader.go`, add:

```go
// NewHashicorpLoader is the exported entry point used by cmd/trigger/main.go.
func NewHashicorpLoader(log *slog.Logger) pluginLoader {
	return newHashicorpLoader(log)
}
```

In `go/internal/trigger/plugins_http.go`, add:

```go
// ServePluginsHTTP is the exported entry point used by cmd/trigger/main.go.
func ServePluginsHTTP(ctx context.Context, lis net.Listener, reg PluginRegistry, log *slog.Logger) error {
	return servePluginsHTTP(ctx, lis, reg, log)
}
```

- [ ] **Step 3: Build.**

```bash
cd go && go build ./cmd/trigger/
```
Expected: no errors.

- [ ] **Step 4: Run all tests to ensure nothing regressed.**

```bash
cd go && go test ./... -count=1
```
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add go/cmd/trigger/main.go go/internal/trigger/plugin_registry.go go/internal/trigger/plugin_loader.go go/internal/trigger/plugins_http.go
git commit -m "feat(trigger): wire plugin registry + http listener into main"
```

---

## Task 11: claude-code plugin binary

**Files:**
- Create: `go/cmd/driver-claude-code/main.go`
- Create: `go/cmd/driver-claude-code/driver.go`
- Create: `go/cmd/driver-claude-code/driver_test.go`

- [ ] **Step 1: Write failing tests.**

Create `go/cmd/driver-claude-code/driver_test.go`:

```go
package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/zdavison/boilerhouse/go/pkg/driverplugin"
)

// bridgeBehavior describes how the fake bridge responds to incoming messages.
type bridgeBehavior struct {
	skipReady bool // if true, never send {ready} after {init}
	output    []string
	final     string // "idle", "exit", or "" (hang)
	exitCode  int
	stderr    string
}

// startFakeBridge stands up an httptest.Server that upgrades /ws to a WebSocket
// and plays out the behavior. Returns the server URL (e.g. "http://127.0.0.1:NNNN").
func startFakeBridge(t *testing.T, behavior bridgeBehavior) *httptest.Server {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()

		// Expect {init, tenantId}.
		var msg map[string]any
		if err := conn.ReadJSON(&msg); err != nil {
			return
		}
		assert.Equal(t, "init", msg["type"])
		assert.NotEmpty(t, msg["tenantId"])

		if behavior.skipReady {
			time.Sleep(5 * time.Second)
			return
		}
		_ = conn.WriteJSON(map[string]any{"type": "ready"})

		// Expect {prompt, text}.
		if err := conn.ReadJSON(&msg); err != nil {
			return
		}
		assert.Equal(t, "prompt", msg["type"])

		for _, chunk := range behavior.output {
			_ = conn.WriteJSON(map[string]any{"type": "output", "text": chunk})
		}
		switch behavior.final {
		case "idle":
			_ = conn.WriteJSON(map[string]any{"type": "idle"})
		case "exit":
			_ = conn.WriteJSON(map[string]any{"type": "exit", "code": behavior.exitCode, "stderr": behavior.stderr})
		}
	})
	return httptest.NewServer(mux)
}

func wsURL(httpURL string) string {
	return strings.Replace(httpURL, "http://", "ws://", 1)
}

func TestClaudeCode_Success(t *testing.T) {
	srv := startFakeBridge(t, bridgeBehavior{
		output: []string{"hel", "lo"},
		final:  "idle",
	})
	defer srv.Close()

	d := &claudeCodeDriver{handshakeTimeout: 2 * time.Second, overallTimeout: 5 * time.Second}
	resp, err := d.Send(context.Background(), driverplugin.SendRequest{
		Endpoint: srv.URL,
		TenantId: "tg-alice",
		Payload:  driverplugin.TriggerPayload{Text: "hi"},
	})
	require.NoError(t, err)
	assert.Equal(t, "hello", resp.Text)
}

func TestClaudeCode_ExitWithEmptyOutput(t *testing.T) {
	srv := startFakeBridge(t, bridgeBehavior{
		final:    "exit",
		exitCode: 2,
		stderr:   "boom",
	})
	defer srv.Close()

	d := &claudeCodeDriver{handshakeTimeout: 2 * time.Second, overallTimeout: 5 * time.Second}
	resp, err := d.Send(context.Background(), driverplugin.SendRequest{
		Endpoint: srv.URL,
		TenantId: "t",
		Payload:  driverplugin.TriggerPayload{Text: "hi"},
	})
	require.NoError(t, err)
	assert.Contains(t, resp.Text, "exited with code 2")
	assert.Contains(t, resp.Text, "boom")
}

func TestClaudeCode_HandshakeTimeout(t *testing.T) {
	srv := startFakeBridge(t, bridgeBehavior{skipReady: true})
	defer srv.Close()

	d := &claudeCodeDriver{handshakeTimeout: 100 * time.Millisecond, overallTimeout: 5 * time.Second}
	_, err := d.Send(context.Background(), driverplugin.SendRequest{
		Endpoint: srv.URL,
		TenantId: "t",
		Payload:  driverplugin.TriggerPayload{Text: "hi"},
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "handshake")
}

func TestClaudeCode_ConnectionRefused(t *testing.T) {
	d := &claudeCodeDriver{handshakeTimeout: 1 * time.Second, overallTimeout: 2 * time.Second}
	_, err := d.Send(context.Background(), driverplugin.SendRequest{
		Endpoint: "http://127.0.0.1:1",
		TenantId: "t",
		Payload:  driverplugin.TriggerPayload{Text: "hi"},
	})
	require.Error(t, err)
}

// silence unused-import warnings if json happens unused in a variant
var _ = json.Marshal
```

- [ ] **Step 2: Run — expect undefined type `claudeCodeDriver`.**

```bash
cd go && go test ./cmd/driver-claude-code/ -count=1 2>&1 | tail -5
```

- [ ] **Step 3: Implement the driver.**

Create `go/cmd/driver-claude-code/driver.go`:

```go
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"

	"github.com/zdavison/boilerhouse/go/pkg/driverplugin"
)

const (
	defaultHandshakeTimeout = 10 * time.Second
	defaultOverallTimeout   = 300 * time.Second
)

// claudeCodeDriver dials the workload's /ws bridge, runs the init/prompt
// exchange, and returns the accumulated output text. Implements DriverPlugin.
type claudeCodeDriver struct {
	handshakeTimeout time.Duration
	overallTimeout   time.Duration
}

func (d *claudeCodeDriver) Name(_ context.Context) (string, error) {
	return "claude-code", nil
}

func (d *claudeCodeDriver) Send(ctx context.Context, req driverplugin.SendRequest) (driverplugin.SendResponse, error) {
	handshakeTimeout := d.handshakeTimeout
	if handshakeTimeout == 0 {
		handshakeTimeout = defaultHandshakeTimeout
	}
	overallTimeout := d.overallTimeout
	if overallTimeout == 0 {
		overallTimeout = defaultOverallTimeout
	}

	ctx, cancel := context.WithTimeout(ctx, overallTimeout)
	defer cancel()

	wsEndpoint := endpointToWS(req.Endpoint)

	dialer := websocket.Dialer{HandshakeTimeout: handshakeTimeout}
	conn, _, err := dialer.DialContext(ctx, wsEndpoint, http.Header{})
	if err != nil {
		return driverplugin.SendResponse{}, fmt.Errorf("dial %s: %w", wsEndpoint, err)
	}
	defer conn.Close()

	if err := conn.WriteJSON(map[string]any{"type": "init", "tenantId": req.TenantId}); err != nil {
		return driverplugin.SendResponse{}, fmt.Errorf("send init: %w", err)
	}

	if err := waitForReady(conn, handshakeTimeout); err != nil {
		return driverplugin.SendResponse{}, err
	}

	if err := conn.WriteJSON(map[string]any{"type": "prompt", "text": req.Payload.Text}); err != nil {
		return driverplugin.SendResponse{}, fmt.Errorf("send prompt: %w", err)
	}

	_ = conn.SetReadDeadline(time.Now().Add(overallTimeout))

	var sb strings.Builder
	for {
		var msg map[string]any
		if err := conn.ReadJSON(&msg); err != nil {
			return driverplugin.SendResponse{}, fmt.Errorf("read: %w", err)
		}
		mtype, _ := msg["type"].(string)
		switch mtype {
		case "output":
			if text, ok := msg["text"].(string); ok {
				sb.WriteString(text)
			}
		case "idle":
			return driverplugin.SendResponse{Text: sb.String()}, nil
		case "exit":
			if sb.Len() > 0 {
				return driverplugin.SendResponse{Text: sb.String()}, nil
			}
			code := 1
			if n, ok := msg["code"].(float64); ok {
				code = int(n)
			}
			stderr, _ := msg["stderr"].(string)
			detail := ""
			if stderr != "" {
				detail = "\n" + stderr
			}
			return driverplugin.SendResponse{Text: fmt.Sprintf("Claude Code exited with code %d%s", code, detail)}, nil
		case "error":
			msgText, _ := msg["message"].(string)
			return driverplugin.SendResponse{}, fmt.Errorf("bridge error: %s", msgText)
		}
	}
}

// waitForReady reads messages until {ready} or timeout. Unexpected message
// types before {ready} are ignored. Returns an error on timeout or read error.
func waitForReady(conn *websocket.Conn, timeout time.Duration) error {
	_ = conn.SetReadDeadline(time.Now().Add(timeout))
	defer conn.SetReadDeadline(time.Time{})

	for {
		var msg map[string]any
		if err := conn.ReadJSON(&msg); err != nil {
			return fmt.Errorf("handshake: %w", err)
		}
		if t, _ := msg["type"].(string); t == "ready" {
			return nil
		}
	}
}

func endpointToWS(endpoint string) string {
	s := strings.TrimRight(endpoint, "/")
	if strings.HasPrefix(s, "https://") {
		return "wss://" + strings.TrimPrefix(s, "https://") + "/ws"
	}
	if strings.HasPrefix(s, "http://") {
		return "ws://" + strings.TrimPrefix(s, "http://") + "/ws"
	}
	return s + "/ws"
}

// silence unused-import warnings across variants
var _ = json.Marshal
```

- [ ] **Step 4: Write main.**

Create `go/cmd/driver-claude-code/main.go`:

```go
package main

import (
	"github.com/hashicorp/go-plugin"

	"github.com/zdavison/boilerhouse/go/pkg/driverplugin"
)

func main() {
	plugin.Serve(&plugin.ServeConfig{
		HandshakeConfig: driverplugin.Handshake,
		Plugins: map[string]plugin.Plugin{
			driverplugin.DispenseKey: &driverplugin.DriverGRPCPlugin{Impl: &claudeCodeDriver{}},
		},
		GRPCServer: plugin.DefaultGRPCServer,
	})
}
```

- [ ] **Step 5: Run tests.**

```bash
cd go && go test ./cmd/driver-claude-code/ -count=1 -v
```
Expected: all four tests PASS.

- [ ] **Step 6: Build the binary as a sanity check.**

```bash
cd go && go build -o /tmp/driver-claude-code ./cmd/driver-claude-code/
```
Expected: no errors.

- [ ] **Step 7: Commit.**

```bash
git add go/cmd/driver-claude-code/
git commit -m "feat(trigger): claude-code driver plugin binary"
```

---

## Task 12: openclaw plugin binary

**Files:**
- Create: `go/cmd/driver-openclaw/main.go`
- Create: `go/cmd/driver-openclaw/driver.go`
- Create: `go/cmd/driver-openclaw/driver_test.go`

- [ ] **Step 1: Write failing tests.**

Create `go/cmd/driver-openclaw/driver_test.go`:

```go
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/zdavison/boilerhouse/go/pkg/driverplugin"
)

// writeSSE writes a sequence of SSE "data: <json>" lines followed by [DONE].
func writeSSE(w http.ResponseWriter, chunks []string) {
	flusher := w.(http.Flusher)
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	for _, c := range chunks {
		fmt.Fprintf(w, "data: %s\n\n", c)
		flusher.Flush()
	}
	fmt.Fprintf(w, "data: [DONE]\n\n")
	flusher.Flush()
}

func makeDelta(text string) string {
	b, _ := json.Marshal(map[string]any{
		"choices": []any{
			map[string]any{"delta": map[string]any{"content": text}},
		},
	})
	return string(b)
}

func TestOpenclaw_Success(t *testing.T) {
	var (
		gotAuth, gotSession string
		gotBody             map[string]any
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/v1/chat/completions", r.URL.Path)
		gotAuth = r.Header.Get("Authorization")
		gotSession = r.Header.Get("X-OpenClaw-Session-Key")
		require.NoError(t, json.NewDecoder(r.Body).Decode(&gotBody))
		writeSSE(w, []string{makeDelta("he"), makeDelta("llo"), "{malformed}"})
	}))
	defer srv.Close()

	opts, _ := json.Marshal(map[string]any{"gatewayToken": "sek"})
	d := &openclawDriver{}
	resp, err := d.Send(context.Background(), driverplugin.SendRequest{
		Endpoint: srv.URL,
		TenantId: "tg-alice",
		Payload:  driverplugin.TriggerPayload{Text: "hi"},
		Options:  opts,
	})
	require.NoError(t, err)

	assert.Equal(t, "hello", resp.Text)
	assert.Equal(t, "Bearer sek", gotAuth)
	assert.Equal(t, "tg-alice", gotSession)
	assert.Equal(t, "openclaw", gotBody["model"])
	messages, ok := gotBody["messages"].([]any)
	require.True(t, ok)
	require.Len(t, messages, 1)
	msg := messages[0].(map[string]any)
	assert.Equal(t, "user", msg["role"])
	assert.Equal(t, "hi", msg["content"])
}

func TestOpenclaw_MissingGatewayToken(t *testing.T) {
	d := &openclawDriver{}
	_, err := d.Send(context.Background(), driverplugin.SendRequest{
		Endpoint: "http://unused",
		TenantId: "t",
		Payload:  driverplugin.TriggerPayload{Text: "hi"},
		Options:  json.RawMessage(`{}`),
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "gatewayToken")
}

func TestOpenclaw_NonOKResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "bad", http.StatusBadGateway)
	}))
	defer srv.Close()

	opts, _ := json.Marshal(map[string]any{"gatewayToken": "x"})
	d := &openclawDriver{}
	_, err := d.Send(context.Background(), driverplugin.SendRequest{
		Endpoint: srv.URL, TenantId: "t", Payload: driverplugin.TriggerPayload{}, Options: opts,
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "502")
}
```

- [ ] **Step 2: Run — expect undefined.**

```bash
cd go && go test ./cmd/driver-openclaw/ -count=1 2>&1 | tail -5
```

- [ ] **Step 3: Implement the driver.**

Create `go/cmd/driver-openclaw/driver.go`:

```go
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/zdavison/boilerhouse/go/pkg/driverplugin"
)

// openclawDriver POSTs to <endpoint>/v1/chat/completions with Bearer auth
// and reads an SSE stream, accumulating choices[0].delta.content.
type openclawDriver struct {
	httpClient *http.Client
}

func (d *openclawDriver) Name(_ context.Context) (string, error) {
	return "openclaw", nil
}

type openclawOptions struct {
	GatewayToken string `json:"gatewayToken"`
}

func (d *openclawDriver) Send(ctx context.Context, req driverplugin.SendRequest) (driverplugin.SendResponse, error) {
	var opts openclawOptions
	if len(req.Options) > 0 {
		if err := json.Unmarshal(req.Options, &opts); err != nil {
			return driverplugin.SendResponse{}, fmt.Errorf("openclaw: parse options: %w", err)
		}
	}
	if opts.GatewayToken == "" {
		return driverplugin.SendResponse{}, fmt.Errorf("openclaw: gatewayToken is required")
	}

	body, err := json.Marshal(map[string]any{
		"model":    "openclaw",
		"messages": []map[string]string{{"role": "user", "content": req.Payload.Text}},
		"stream":   true,
	})
	if err != nil {
		return driverplugin.SendResponse{}, err
	}

	url := strings.TrimRight(req.Endpoint, "/") + "/v1/chat/completions"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return driverplugin.SendResponse{}, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+opts.GatewayToken)
	httpReq.Header.Set("X-OpenClaw-Session-Key", req.TenantId)

	client := d.httpClient
	if client == nil {
		client = http.DefaultClient
	}

	resp, err := client.Do(httpReq)
	if err != nil {
		return driverplugin.SendResponse{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(resp.Body)
		return driverplugin.SendResponse{}, fmt.Errorf("openclaw: status %d: %s", resp.StatusCode, string(raw))
	}

	var sb strings.Builder
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)

	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" || payload == "[DONE]" {
			continue
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			continue // skip malformed lines
		}
		if len(chunk.Choices) > 0 {
			sb.WriteString(chunk.Choices[0].Delta.Content)
		}
	}
	if err := scanner.Err(); err != nil {
		return driverplugin.SendResponse{}, fmt.Errorf("openclaw: read stream: %w", err)
	}

	return driverplugin.SendResponse{Text: sb.String()}, nil
}
```

- [ ] **Step 4: Write main.**

Create `go/cmd/driver-openclaw/main.go`:

```go
package main

import (
	"github.com/hashicorp/go-plugin"

	"github.com/zdavison/boilerhouse/go/pkg/driverplugin"
)

func main() {
	plugin.Serve(&plugin.ServeConfig{
		HandshakeConfig: driverplugin.Handshake,
		Plugins: map[string]plugin.Plugin{
			driverplugin.DispenseKey: &driverplugin.DriverGRPCPlugin{Impl: &openclawDriver{}},
		},
		GRPCServer: plugin.DefaultGRPCServer,
	})
}
```

- [ ] **Step 5: Run tests.**

```bash
cd go && go test ./cmd/driver-openclaw/ -count=1 -v
```
Expected: three tests PASS.

- [ ] **Step 6: Build.**

```bash
cd go && go build -o /tmp/driver-openclaw ./cmd/driver-openclaw/
```

- [ ] **Step 7: Commit.**

```bash
git add go/cmd/driver-openclaw/
git commit -m "feat(trigger): openclaw driver plugin binary"
```

---

## Task 13: API route + Service for plugin state

**Files:**
- Create: `go/internal/api/routes_plugins.go`
- Create: `go/internal/api/routes_plugins_test.go`
- Modify: `go/internal/api/server.go` (register the route)
- Modify: `config/deploy/trigger.yaml`

- [ ] **Step 1: Write failing test.**

Create `go/internal/api/routes_plugins_test.go`:

```go
package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestPluginsRoute_ProxiesSuccess(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/plugins", r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"plugins":[{"name":"claude-code","kind":"driver","status":"loaded","binary":"/plugins/drivers/claude-code"}]}`))
	}))
	defer upstream.Close()

	h := pluginsHandler(upstream.URL)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/plugins", nil)
	rec := httptest.NewRecorder()
	h(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	body, _ := io.ReadAll(rec.Result().Body)
	var parsed struct {
		Plugins []map[string]any `json:"plugins"`
	}
	require.NoError(t, json.Unmarshal(body, &parsed))
	assert.Len(t, parsed.Plugins, 1)
	assert.Equal(t, "claude-code", parsed.Plugins[0]["name"])
}

func TestPluginsRoute_UpstreamErrorMaps502(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer upstream.Close()

	h := pluginsHandler(upstream.URL)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/plugins", nil)
	rec := httptest.NewRecorder()
	h(rec, req)

	assert.Equal(t, http.StatusBadGateway, rec.Code)
	assert.True(t, strings.Contains(rec.Body.String(), "error"))
}

func TestPluginsRoute_UnreachableUpstreamMaps502(t *testing.T) {
	// Nothing listening on port 1.
	h := pluginsHandler("http://127.0.0.1:1")
	req := httptest.NewRequest(http.MethodGet, "/api/v1/plugins", nil)
	rec := httptest.NewRecorder()
	h(rec, req)

	assert.Equal(t, http.StatusBadGateway, rec.Code)
}
```

- [ ] **Step 2: Run — expect undefined.**

```bash
cd go && go test ./internal/api/ -run TestPluginsRoute -count=1 2>&1 | tail -5
```

- [ ] **Step 3: Implement.**

Create `go/internal/api/routes_plugins.go`:

```go
package api

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

// pluginsHandler returns an http.HandlerFunc that proxies GET requests to
// upstreamURL + "/plugins". Upstream errors map to 502.
func pluginsHandler(upstreamURL string) http.HandlerFunc {
	client := &http.Client{Timeout: 3 * time.Second}
	target := strings.TrimRight(upstreamURL, "/") + "/plugins"

	return func(w http.ResponseWriter, r *http.Request) {
		req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target, nil)
		if err != nil {
			writeJSONError(w, http.StatusBadGateway, "plugins proxy: build request: "+err.Error())
			return
		}
		resp, err := client.Do(req)
		if err != nil {
			writeJSONError(w, http.StatusBadGateway, "plugins proxy: "+err.Error())
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode >= 500 {
			body, _ := io.ReadAll(resp.Body)
			writeJSONError(w, http.StatusBadGateway, "plugins upstream "+resp.Status+": "+string(body))
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, resp.Body)
	}
}

func writeJSONError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
```

- [ ] **Step 4: Register the route.**

In `go/internal/api/server.go`, inside `buildRouter()`, after the `r.Get("/stats", s.getStats)` line (or wherever system-level endpoints live), add:

```go
upstream := os.Getenv("TRIGGER_GATEWAY_URL")
if upstream == "" {
	upstream = "http://boilerhouse-trigger." + s.namespace + ".svc:8091"
}
r.Get("/plugins", pluginsHandler(upstream))
```

Ensure the `os` import is present (it already is).

- [ ] **Step 5: Run tests.**

```bash
cd go && go test ./internal/api/ -run TestPluginsRoute -count=1 -v
```
Expected: three tests PASS.

- [ ] **Step 6: Update the trigger Deployment manifest.**

Rewrite `config/deploy/trigger.yaml` to include a new port and a companion Service:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: boilerhouse-trigger
  namespace: boilerhouse
spec:
  replicas: 1
  selector:
    matchLabels:
      app: boilerhouse-trigger
  template:
    metadata:
      labels:
        app: boilerhouse-trigger
    spec:
      serviceAccountName: boilerhouse-operator
      containers:
        - name: trigger
          image: boilerhouse-trigger:latest
          env:
            - name: K8S_NAMESPACE
              value: boilerhouse
          ports:
            - containerPort: 8082
              name: http
            - containerPort: 8081
              name: health
            - containerPort: 8091
              name: plugins-http
          livenessProbe:
            httpGet:
              path: /healthz
              port: health
          readinessProbe:
            httpGet:
              path: /readyz
              port: health
---
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
      targetPort: plugins-http
```

- [ ] **Step 7: Run full api package tests.**

```bash
cd go && go test ./internal/api/ -count=1
```
Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add go/internal/api/routes_plugins.go go/internal/api/routes_plugins_test.go go/internal/api/server.go config/deploy/trigger.yaml
git commit -m "feat(api): add /api/v1/plugins proxy + trigger Service"
```

---

## Task 14: Dashboard Plugin list page

**Files:**
- Modify: `ts/apps/dashboard/src/api.ts`
- Create: `ts/apps/dashboard/src/pages/PluginList.tsx`
- Modify: `ts/apps/dashboard/src/App.tsx` or wherever routes + sidebar live (inspect first to find the right file)

- [ ] **Step 1: Inspect current sidebar and routing to match style.**

```bash
grep -rn "TriggerList" ts/apps/dashboard/src/
```

Identify the file where route `/triggers` is registered and the sidebar link is rendered. The following steps assume those files are `App.tsx` and (sidebar component) — adjust to the actual file names found.

- [ ] **Step 2: Add API client function.**

Append to `ts/apps/dashboard/src/api.ts`:

```typescript
export interface PluginState {
	name?: string;
	kind: "driver" | string;
	binary: string;
	status: "loaded" | "error";
	error?: string;
	loadedAt?: string;
	failedAt?: string;
}

export interface PluginsResponse {
	plugins: PluginState[];
}

export const api = {
	// ... existing exports (keep them all) ...
	listPlugins(): Promise<PluginsResponse> {
		return get<PluginsResponse>("/plugins");
	},
};
```

If `api.ts` doesn't already export a single `api` object — it uses bare `async function get` / `post` — add `listPlugins` as a top-level async function instead:

```typescript
export async function listPlugins(): Promise<PluginsResponse> {
	return get<PluginsResponse>("/plugins");
}
```

- [ ] **Step 3: Write the page component.**

Create `ts/apps/dashboard/src/pages/PluginList.tsx`:

```tsx
import { useEffect, useState } from "react";
import { listPlugins, type PluginState } from "../api";

function formatTime(iso?: string): string {
	if (!iso) return "";
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function PluginList() {
	const [plugins, setPlugins] = useState<PluginState[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		listPlugins()
			.then((resp) => setPlugins(resp.plugins))
			.catch((err) => setError(err instanceof Error ? err.message : String(err)));
	}, []);

	if (error) {
		return <div className="plugin-list-error">Failed to load plugins: {error}</div>;
	}
	if (plugins === null) {
		return <div>Loading plugins…</div>;
	}

	return (
		<div className="plugin-list">
			<h1>Plugins</h1>
			{plugins.length === 0 ? (
				<p>No plugins loaded.</p>
			) : (
				<table>
					<thead>
						<tr>
							<th>Name</th>
							<th>Kind</th>
							<th>Binary</th>
							<th>Status</th>
							<th>Time</th>
						</tr>
					</thead>
					<tbody>
						{plugins.map((p) => (
							<tr key={p.binary}>
								<td>{p.name ?? <em>(unknown)</em>}</td>
								<td>{p.kind}</td>
								<td><code>{p.binary}</code></td>
								<td>
									<span className={`status status-${p.status}`}>
										{p.status}
									</span>
									{p.status === "error" && p.error && (
										<details>
											<summary>details</summary>
											<pre>{p.error}</pre>
										</details>
									)}
								</td>
								<td>{formatTime(p.loadedAt ?? p.failedAt)}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</div>
	);
}
```

- [ ] **Step 4: Register the route and sidebar link.**

In the file where routes are declared (typically `App.tsx`), add:

```tsx
import { PluginList } from "./pages/PluginList";

// Inside the <Routes> block:
<Route path="/plugins" element={<PluginList />} />
```

In the sidebar component, add a link below Triggers:

```tsx
<NavLink to="/plugins">Plugins</NavLink>
```

Match the existing style exactly.

- [ ] **Step 5: Manual verification.**

Dashboard is not unit-tested per project convention. Run the dashboard against a live cluster, hit `/plugins`, verify the list renders. The user will do this manually at ship time.

- [ ] **Step 6: Commit.**

```bash
git add ts/apps/dashboard/src/api.ts ts/apps/dashboard/src/pages/PluginList.tsx ts/apps/dashboard/src/App.tsx
# plus whichever sidebar file was edited
git commit -m "feat(dashboard): add Plugins page"
```

---

## Task 15: Example trigger templates

**Files:**
- Create: `workloads/claude-code-trigger.yaml`
- Create: `workloads/openclaw-trigger.yaml`

- [ ] **Step 1: Create claude-code template.**

Write `workloads/claude-code-trigger.yaml`:

```yaml
# Telegram-triggered claude-code agent.
#
# Prereq: create these Secrets in the boilerhouse namespace before applying:
#
#   kubectl -n boilerhouse create secret generic telegram-bot-token \
#     --from-literal=token="<your telegram bot token>"
#
# Update the allowlist tenantIds with the telegram usernames/ids that
# should be permitted.
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

- [ ] **Step 2: Create openclaw template.**

Write `workloads/openclaw-trigger.yaml`:

```yaml
# Telegram-triggered openclaw agent.
#
# Prereq: create these Secrets in the boilerhouse namespace before applying:
#
#   kubectl -n boilerhouse create secret generic telegram-bot-token \
#     --from-literal=token="<your telegram bot token>"
#
#   kubectl -n boilerhouse create secret generic openclaw-gateway-token \
#     --from-literal=token="<openclaw gateway token from the workload env>"
#
# Update the allowlist tenantIds with the telegram usernames/ids that
# should be permitted.
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

- [ ] **Step 3: Validate the YAML parses.**

```bash
cd go && go run ./cmd/api/ --help >/dev/null 2>&1 || true  # no-op; just ensures the binary builds
kubectl apply --dry-run=client -f ../workloads/claude-code-trigger.yaml
kubectl apply --dry-run=client -f ../workloads/openclaw-trigger.yaml
```

The second and third commands require the CRDs to be installed in the target cluster OR `--dry-run=client` to skip server validation. `--dry-run=client` is enough for this step — we just want the YAML to parse and the schema basics to be right.

- [ ] **Step 4: Commit.**

```bash
git add workloads/claude-code-trigger.yaml workloads/openclaw-trigger.yaml
git commit -m "docs(workloads): example telegram triggers for claude-code + openclaw"
```

---

## Task 16: Dockerfile — build and ship plugin binaries

The trigger container needs to contain the two first-party plugin binaries at `/plugins/drivers/`. The existing Dockerfile is in `config/deploy/` or at the repo root — inspect first.

**Files:**
- Modify (or create): the trigger Dockerfile

- [ ] **Step 1: Locate the current trigger image build.**

```bash
grep -rn "boilerhouse-trigger\|cmd/trigger" config/ --include="Dockerfile*"
find . -name "Dockerfile*" -not -path "./node_modules/*" -not -path "./ts/node_modules/*"
```

Note the paths returned. Let `$TRIGGER_DOCKERFILE` denote the existing file that builds `cmd/trigger`. If none exists, create one at `config/deploy/Dockerfile.trigger`.

- [ ] **Step 2: Extend the Dockerfile build stage to also build the plugin binaries.**

Append plugin builds to the build stage and plugin copies to the final stage. Example (adapt to the existing structure):

```dockerfile
# --- build stage ---
# existing: go build -o /out/boilerhouse-trigger ./cmd/trigger
RUN go build -o /out/boilerhouse-trigger        ./cmd/trigger/         \
 && go build -o /out/driver-claude-code         ./cmd/driver-claude-code/ \
 && go build -o /out/driver-openclaw            ./cmd/driver-openclaw/

# --- final stage ---
# existing: COPY --from=build /out/boilerhouse-trigger /usr/bin/
COPY --from=build /out/boilerhouse-trigger  /usr/bin/boilerhouse-trigger
COPY --from=build /out/driver-claude-code   /plugins/drivers/claude-code
COPY --from=build /out/driver-openclaw      /plugins/drivers/openclaw

ENV BOILERHOUSE_PLUGIN_DIR=/plugins/drivers
```

- [ ] **Step 3: Build the image locally to verify.**

```bash
docker build -t boilerhouse-trigger:dev -f <TRIGGER_DOCKERFILE> .
docker run --rm --entrypoint ls boilerhouse-trigger:dev /plugins/drivers
```
Expected: the listing shows `claude-code` and `openclaw`.

- [ ] **Step 4: Commit.**

```bash
git add <TRIGGER_DOCKERFILE>
git commit -m "build(trigger): bake claude-code + openclaw plugins into image"
```

---

## Self-Review Notes

After all tasks complete, spot-check:

- **Driver interface consistency.** Search for any stray `driver.Send(ctx, endpoint, payload)` with three args — every call site must pass four.
- **Secret-ref field names.** `gatewayTokenSecretRef` and `botTokenSecretRef` — consistent camelCase across Go structs, JSON tags, YAML templates, and gateway resolvers.
- **Plugin registry has exactly one `loaded` entry per successfully-loaded binary.** Duplicate-name path produces one `loaded` + one `error`.
- **The trigger pod has a Service** so the API can resolve it — otherwise `/api/v1/plugins` returns 502 forever in prod.
- **Templates name-match workloads** (`workloadRef: claude-code` and `workloadRef: openclaw` align with existing `workloads/claude-code.yaml` / `workloads/openclaw.yaml`).
