# CLI Reference

::: warning Legacy — TypeScript implementation only
The `boilerhouse` CLI documented on this page is part of the original TypeScript implementation. It has **not** been ported to the Go rewrite yet and currently does not live in the repository.

A Go port is planned; commands, flags, and defaults will likely change. Treat this page as historical reference — for current development workflows use `bunx kadai run <action>` and `kubectl` directly (see [Quick Start](../guide/quick-start)).
:::

The Boilerhouse CLI (`boilerhouse`) provides commands for running and managing the API server.

## Installation

### Build from Source

```bash
cd boilerhouse
bun build apps/cli/src/main.ts --compile --outfile boilerhouse
```

### Self-Update

```bash
boilerhouse update
```

Downloads the latest release binary.

## Commands

### `boilerhouse api start`

Start the API server in the foreground.

```bash
boilerhouse api start
```

The server listens on `LISTEN_HOST:PORT` (default: `127.0.0.1:3000`). All configuration is via environment variables — see [Environment Variables](./env).

Press `Ctrl+C` to stop.

### `boilerhouse api install`

Install the API server as a systemd service.

```bash
boilerhouse api install \
  --binary-path /usr/local/bin/boilerhouse \
  --data-dir /var/lib/boilerhouse
```

**Options:**

| Flag | Description |
|------|-------------|
| `--binary-path` | Path to the boilerhouse binary |
| `--data-dir` | Working directory for the service (database, storage) |

This creates a systemd unit at `/etc/systemd/system/boilerhouse.service` and enables it.

After installation:

```bash
sudo systemctl start boilerhouse
sudo systemctl status boilerhouse
sudo journalctl -u boilerhouse -f
```

### `boilerhouse update`

Download and install the latest Boilerhouse release.

```bash
boilerhouse update
```

Checks for a new version and downloads the binary for your platform.

### `boilerhouse version`

Print version information.

```bash
boilerhouse version
```

Output:

```
boilerhouse v1.2.3 (abc1234)
```

Includes the version number and the git commit hash the binary was built from.
