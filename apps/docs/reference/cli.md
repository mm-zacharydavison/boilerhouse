# CLI Reference

The `boilerhouse` binary is a single executable that bundles the API server, service installer, and self-updater.

## Installation

Download the latest binary from GitHub Releases for your platform, or build from source:

```bash
bun run build
# Produces ./boilerhouse
```

The compiled binary is self-contained and requires no external runtime.

## Commands

### `boilerhouse api start`

Start the API server in the foreground.

```bash
boilerhouse api start
```

The server loads configuration from environment variables. If `BOILERHOUSE_SECRET_KEY` is not set in the environment, the command attempts to load `/etc/boilerhouse/api.env` as a fallback (useful when running as a systemd service).

See [Configuration](../guide/configuration.md) for all available environment variables.

::: tip
For local development, you can pass variables inline:
```bash
BOILERHOUSE_SECRET_KEY=$(openssl rand -hex 32) PORT=8080 boilerhouse api start
```
:::

### `boilerhouse api install`

Install Boilerhouse as a systemd service. Requires root.

```bash
sudo boilerhouse api install [flags]
```

**Flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--binary-path` | Current executable path | Path to the Boilerhouse binary to run as a service |
| `--data-dir` | `/var/lib/boilerhouse` | Data directory for the database and storage |

This command performs the following steps:

1. Generates `/etc/boilerhouse/api.env` with a random `BOILERHOUSE_SECRET_KEY` if the file does not already exist
2. Writes a systemd unit file to `/etc/systemd/system/boilerhouse-api.service`
3. Runs `systemctl daemon-reload`, `enable`, and `start`

After installation, manage the service with:

```bash
sudo systemctl status boilerhouse-api
sudo systemctl restart boilerhouse-api
sudo journalctl -u boilerhouse-api -f
```

Edit `/etc/boilerhouse/api.env` to change configuration, then restart the service.

### `boilerhouse update`

Self-update to the latest release.

```bash
boilerhouse update
```

This command:

1. Fetches the latest release tag from the GitHub API
2. Downloads the appropriate binary for the current platform (`linux/amd64` or `linux/arm64`)
3. Atomically replaces the current binary

The command fails if running a development build (no version tag embedded). After updating, restart the service to use the new version.

### `boilerhouse version`

Print version and build information.

```bash
boilerhouse version
```

Output:

```
boilerhouse 0.1.11
```

Also available as `boilerhouse --version` or `boilerhouse -V`.
