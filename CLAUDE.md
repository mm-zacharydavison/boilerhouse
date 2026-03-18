# Boilerhouse

NOT-RELEASED

## Testing

### Unit tests

```sh
bun test --recursive
```

### Integration tests (Podman)

Require the Podman API socket (default `/var/run/boilerhouse/podman.sock`).
Override with `PODMAN_SOCKET` env var. For CRIU snapshot/restore tests:

```sh
BOILERHOUSE_CRIU_AVAILABLE=true bun test packages/runtime-podman/src/runtime.integration.test.ts --timeout 60000
```

### Integration tests (Kubernetes)

Require a minikube cluster with profile `boilerhouse-test`.
Set up with `bunx kadai run minikube`. Teardown with
`minikube delete -p boilerhouse-test`.

```sh
bun test packages/runtime-kubernetes/src/runtime.integration.test.ts --timeout 60000
```

### E2E tests

E2E tests run against **all** available runtimes, not just fake. When
running E2E tests locally, ensure the Podman socket is available and CRIU
is installed so that podman tests are included. For Kubernetes tests,
start minikube with `bunx kadai run minikube`.

```sh
# Run all E2E tests against all detected runtimes (fake + podman + kubernetes)
BOILERHOUSE_CRIU_AVAILABLE=true bun test apps/api/src/e2e/ --timeout 120000

# Filter to specific runtimes with BOILERHOUSE_E2E_RUNTIMES (comma-separated)
BOILERHOUSE_E2E_RUNTIMES=fake,podman bun test apps/api/src/e2e/ --timeout 120000
BOILERHOUSE_E2E_RUNTIMES=kubernetes bun test apps/api/src/e2e/ --timeout 120000
```

Real runtime tests (podman, kubernetes) need longer timeouts than the
default 5s. Use `--timeout 60000` or higher.
