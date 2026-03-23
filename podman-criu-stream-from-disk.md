# Plan: Stream CRIU Checkpoint Archives from Disk to Podman

## Problem

The current restore flow buffers the entire checkpoint archive (~255MB) in daemon memory before sending it to Podman. This wastes ~510MB of memory (two copies) and adds ~170ms of latency before Podman can start working.

## Current Flow

```
Disk -> Bun.file().arrayBuffer() [255MB alloc]
     -> Buffer.from(data)        [255MB copy]
     -> req.write(buffer)        [send to Podman socket]
     -> Podman extracts tar
     -> CRIU restores process
```

**Hop 1: API -> Daemon** (`DaemonBackend.restore()` in `packages/runtime-podman/src/daemon-backend.ts:74-88`)
- Sends only `{ archivePath, name, publishPorts, pod, encrypted }` JSON. Cheap.

**Hop 2: Daemon reads archive** (`handleRestore()` in `apps/boilerhouse-podmand/src/main.ts:513-525`)
```typescript
const data = await Bun.file(body.archivePath).arrayBuffer();  // 255MB alloc
archive = Buffer.from(data);  // 255MB copy
```
Peak memory: ~510MB just for reading.

**Hop 3: Daemon sends buffer to Podman** (`PodmanClient.request()` in `packages/runtime-podman/src/client.ts:576-635`)
```typescript
headers["Content-Length"] = String(bodyData.length);
req.write(bodyData);  // writes entire 255MB buffer into HTTP request
```
Sequential: Podman cannot start extracting until the last byte arrives.

## Proposed Change

Stream the archive directly from disk to the Podman socket. Podman's Go HTTP server reads the request body as an `io.Reader` — it starts extracting the tar incrementally while we're still sending bytes.

### New method on PodmanClient

```typescript
// packages/runtime-podman/src/client.ts

async restoreContainerFromFile(
  archivePath: string,
  name: string,
  publishPorts?: string[],
  pod?: string,
): Promise<string> {
  const stat = await fs.promises.stat(archivePath);

  let path =
    `/libpod/containers/${encodeURIComponent(name)}/restore` +
    `?import=true&name=${encodeURIComponent(name)}` +
    `&tcpClose=true`;

  if (publishPorts?.length) {
    path += `&publishPorts=${encodeURIComponent(publishPorts.join(" "))}`;
  }
  if (pod) {
    path += `&pod=${encodeURIComponent(pod)}`;
  }

  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: this.socketPath,
      path: `${this.apiBase}${path}`,
      method: "POST",
      headers: {
        "Content-Type": "application/x-tar",
        "Content-Length": String(stat.size),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if ((res.statusCode ?? 0) >= 400) {
          reject(new PodmanRuntimeError(
            `Failed to restore container: ${body?.message ?? "unknown error"}`
          ));
          return;
        }
        resolve(body.Id);
      });
    });

    req.on("error", reject);

    const fileStream = fs.createReadStream(archivePath);
    fileStream.on("error", (err) => {
      req.destroy(err);
      reject(new PodmanRuntimeError(`Failed to read archive: ${err.message}`));
    });
    fileStream.pipe(req);  // 64KB chunks, disk -> socket
  });
}
```

### Daemon changes

In `handleRestore()` (`apps/boilerhouse-podmand/src/main.ts`), split by encryption:

```typescript
// Unencrypted: stream directly from disk, zero buffering
if (!body.encrypted) {
  const podmanId = await daemonTracer.startActiveSpan(
    "daemon.podman_restore", {}, parentCtx, async (span) => {
      const stat = await fs.promises.stat(body.archivePath);
      span.setAttribute("archive.size_bytes", stat.size);
      span.setAttribute("archive.streamed", true);
      const id = await client.restoreContainerFromFile(
        body.archivePath, body.name, body.publishPorts, body.pod
      );
      span.setAttribute("container.id", id);
      return id;
    }
  );
  registerContainer(podmanId, body.name);
  return jsonResponse(200, { id: podmanId });
}

// Encrypted: must buffer for decryption (existing flow)
const archive = await daemonTracer.startActiveSpan("daemon.archive_read", ...);
const decrypted = await daemonTracer.startActiveSpan("daemon.archive_decrypt", ...);
const podmanId = await client.restoreContainer(decrypted, body.name, ...);
```

## Expected Improvement

| Metric | Current | Streaming |
|---|---|---|
| Daemon peak memory per restore | ~510MB | ~64KB |
| `daemon.archive_read` latency | ~170ms | eliminated |
| Pipeline parallelism | none (sequential) | Podman extracts while streaming |
| Concurrent restore capacity | ~4 before OOM | essentially unlimited |

Conservative end-to-end estimate: **150-250ms faster** per restore. The bigger win is memory — 4 concurrent restores currently need ~2GB, streaming needs ~256KB.

## Risks

- **Stream errors mid-transfer**: If the file read fails partway through, Podman gets a truncated tar and returns a 500. The daemon must catch `fileStream.on("error")` and destroy the request. Checkpoint archives are immutable once written, so this is unlikely.
- **Content-Length mismatch**: If the file changes between `stat()` and stream completion. Mitigated by archive immutability.
- **Bun compatibility**: Bun's `node:http` must support piping `ReadStream` into `ClientRequest`. Works as of Bun 1.x but should be tested.
- **Encrypted archives**: Cannot use streaming path — must still buffer for decryption. This is handled by the branching logic above.

## Alternative Considered: Podman CLI

Instead of HTTP streaming, shell out to `podman container restore --import /path`:
- Pro: Zero copies, Podman reads file directly
- Con: Requires `podman` binary on PATH, output parsing less stable, harder to test

Not recommended as the primary approach — HTTP streaming provides 99%+ of the benefit without external binary dependency.

## Files to Change

1. `packages/runtime-podman/src/client.ts` — add `restoreContainerFromFile()` method
2. `apps/boilerhouse-podmand/src/main.ts` — branch on `encrypted`, skip buffering for unencrypted
3. `packages/runtime-podman/src/daemon-backend.test.ts` — add tests for streaming path
