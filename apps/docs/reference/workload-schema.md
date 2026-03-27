# Workload Schema

## `defineWorkload(config)`

<!-- WRITE: full typed schema reference for the workload definition object -->

### `name`
<!-- WRITE: string, required, naming rules -->

### `version`
<!-- WRITE: string, semver -->

### `image`
<!-- WRITE: { dockerfile } or { ref }, image resolution -->

### `resources`
<!-- WRITE: { vcpus, memory_mb, disk_gb } -->

### `network`
<!-- WRITE: { access, allowlist, expose, websocket, credentials } -->

### `filesystem`
<!-- WRITE: { overlay_dirs } -->

### `idle`
<!-- WRITE: { timeout_seconds, action, watch_dirs } -->

### `health`
<!-- WRITE: { interval_seconds, http_get, exec } -->

### `entrypoint`
<!-- WRITE: { cmd, args, workdir, env } -->

### `pool`
<!-- WRITE: { min_instances, max_instances } -->

### `metadata`
<!-- WRITE: { description, ... } -->
