# Compose-to-K8s Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically deploy functional infrastructure deps from `docker-compose.yml` into the minikube cluster so kubernetes E2E tests work without maintaining separate manifests.

**Architecture:** A Bun script (`scripts/compose-to-k8s.ts`) reads compose config as JSON via `docker compose config --format json`, filters out observability services, and emits Kubernetes Deployment + Service YAML to stdout. `minikube.sh` pipes this to `kubectl apply`. E2E and dev scripts set `REDIS_URL` to the in-cluster service address when running against kubernetes.

**Tech Stack:** Bun/TypeScript, `docker compose config --format json` (no YAML parser needed), kubectl

**Spec:** `docs/superpowers/specs/2026-04-03-compose-to-k8s-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `scripts/compose-to-k8s.ts` | Create | Read compose JSON, generate k8s manifests |
| `scripts/compose-to-k8s.test.ts` | Create | Unit tests for manifest generation |
| `.kadai/actions/minikube.sh` | Modify | Call translator script, wait for readiness |
| `.kadai/actions/tests/e2e.sh` | Modify | Set `REDIS_URL` for kubernetes runtime |
| `.kadai/actions/dev.sh` | Modify | Set `REDIS_URL` for kubernetes runtime |

---

### Task 1: Compose-to-K8s translator script

**Files:**
- Create: `scripts/compose-to-k8s.ts`
- Create: `scripts/compose-to-k8s.test.ts`

This is the core of the feature. The script reads `docker compose config --format json`, filters services, and generates k8s manifests.

- [ ] **Step 1: Write failing tests for manifest generation**

Create `scripts/compose-to-k8s.test.ts`. The tests call the pure generation function directly (no subprocess), using the same JSON shape that `docker compose config --format json` produces.

```ts
import { describe, test, expect } from "bun:test";
import { generateManifests } from "./compose-to-k8s";

// Minimal compose config JSON matching `docker compose config --format json` shape
const COMPOSE_CONFIG = {
  services: {
    redis: {
      image: "redis:7-alpine",
      command: null,
      entrypoint: null,
      environment: {},
      ports: [{ mode: "ingress", target: 6379, published: "6379", protocol: "tcp" }],
    },
    minio: {
      image: "minio/minio:latest",
      command: ["server", "/data", "--console-address", ":9001"],
      entrypoint: null,
      environment: { MINIO_ROOT_USER: "minioadmin", MINIO_ROOT_PASSWORD: "minioadmin" },
      ports: [
        { mode: "ingress", target: 9000, published: "9000", protocol: "tcp" },
        { mode: "ingress", target: 9001, published: "9001", protocol: "tcp" },
      ],
      volumes: [{ type: "volume", source: "minio-data", target: "/data", volume: {} }],
    },
    "minio-init": {
      image: "minio/mc:latest",
      command: null,
      entrypoint: ["/bin/sh", "-c", "sleep 2; mc alias set local http://minio:9000 minioadmin minioadmin; mc mb --ignore-existing local/boilerhouse; echo 'Bucket ready';"],
      depends_on: { minio: { condition: "service_started", required: true } },
    },
    prometheus: {
      image: "prom/prometheus:latest",
      command: ["--config.file=/etc/prometheus/prometheus.yml"],
      entrypoint: null,
      ports: [{ mode: "ingress", target: 9090, published: "9090", protocol: "tcp" }],
    },
    grafana: {
      image: "grafana/grafana:latest",
      entrypoint: null,
      command: null,
      ports: [{ mode: "ingress", target: 3000, published: "3003", protocol: "tcp" }],
    },
    tempo: {
      image: "grafana/tempo:2.7.2",
      entrypoint: null,
      command: ["-config.file=/etc/tempo/tempo.yml"],
      ports: [{ mode: "ingress", target: 4318, published: "4318", protocol: "tcp" }],
    },
  },
};

describe("generateManifests", () => {
  const manifests = generateManifests(COMPOSE_CONFIG);

  test("excludes observability services", () => {
    expect(manifests).not.toContain("prometheus");
    expect(manifests).not.toContain("grafana");
    expect(manifests).not.toContain("tempo");
  });

  test("excludes minio-init as standalone deployment", () => {
    // minio-init should NOT appear as its own Deployment
    const deploymentNames = [...manifests.matchAll(/name: (\S+)\n\s+labels:/g)].map(m => m[1]);
    expect(deploymentNames).not.toContain("minio-init");
  });

  test("generates redis deployment and service", () => {
    expect(manifests).toContain("image: redis:7-alpine");
    expect(manifests).toContain("name: redis");
    expect(manifests).toContain("containerPort: 6379");
    expect(manifests).toContain("kind: Deployment");
    expect(manifests).toContain("kind: Service");
  });

  test("generates minio deployment with init container", () => {
    expect(manifests).toContain("image: minio/minio:latest");
    expect(manifests).toContain("initContainers:");
    expect(manifests).toContain("image: minio/mc:latest");
    expect(manifests).toContain("name: minio-init");
  });

  test("minio init container connects to localhost not minio service name", () => {
    // In k8s, init container is in the same pod — use localhost:9000
    expect(manifests).toContain("http://localhost:9000");
    expect(manifests).not.toContain("http://minio:9000");
  });

  test("minio has emptyDir volume for /data", () => {
    expect(manifests).toContain("emptyDir: {}");
    expect(manifests).toContain("mountPath: /data");
  });

  test("minio has env vars", () => {
    expect(manifests).toContain("MINIO_ROOT_USER");
    expect(manifests).toContain("MINIO_ROOT_PASSWORD");
  });

  test("minio deployment has command", () => {
    expect(manifests).toContain('- "server"');
    expect(manifests).toContain('- "/data"');
  });

  test("services use ClusterIP (default)", () => {
    // No NodePort or LoadBalancer should appear
    expect(manifests).not.toContain("NodePort");
    expect(manifests).not.toContain("LoadBalancer");
  });

  test("output is valid multi-document YAML with separators", () => {
    const docs = manifests.split("---").filter(d => d.trim().length > 0);
    // redis: deployment + service = 2, minio: deployment + service = 2
    expect(docs.length).toBe(4);
  });

  test("all resources have boilerhouse.dev/infra label", () => {
    const matches = manifests.match(/boilerhouse\.dev\/infra: "true"/g);
    // 4 resources (2 deployments + 2 services)
    expect(matches?.length).toBe(4);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test scripts/compose-to-k8s.test.ts`
Expected: FAIL — `generateManifests` doesn't exist yet.

- [ ] **Step 3: Write the translator script**

Create `scripts/compose-to-k8s.ts`:

```ts
/**
 * Reads docker-compose.yml via `docker compose config --format json`
 * and generates Kubernetes Deployment + Service manifests for
 * functional infrastructure dependencies.
 *
 * Usage: bun run scripts/compose-to-k8s.ts
 * Output: YAML to stdout, pipe to `kubectl apply -f -`
 */

// ── Types matching `docker compose config --format json` ────────────────

interface ComposePort {
  mode: string;
  target: number;
  published: string;
  protocol: string;
}

interface ComposeVolume {
  type: string;
  source: string;
  target: string;
}

interface ComposeService {
  image: string;
  command: string[] | null;
  entrypoint: string[] | null;
  environment?: Record<string, string>;
  ports?: ComposePort[];
  volumes?: ComposeVolume[];
  depends_on?: Record<string, unknown>;
}

interface ComposeConfig {
  services: Record<string, ComposeService>;
}

// ── Configuration ───────────────────────────────────────────────────────

/** Services to exclude from k8s translation (observability + utility). */
const EXCLUDE = new Set(["prometheus", "tempo", "grafana", "minio-init"]);

/**
 * Map of init-container services → the parent service they attach to.
 * Key: compose service name that becomes an init container.
 * Value: compose service name it should be attached to.
 */
const INIT_CONTAINERS: Record<string, string> = {
  "minio-init": "minio",
};

// ── Manifest generation ─────────────────────────────────────────────────

function renderEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `        - name: ${k}\n          value: ${JSON.stringify(v)}`)
    .join("\n");
}

function renderPorts(ports: ComposePort[], indent: string): string {
  return ports
    .map((p) => `${indent}- containerPort: ${p.target}`)
    .join("\n");
}

function renderCommand(cmd: string[]): string {
  return cmd.map((c) => `        - ${JSON.stringify(c)}`).join("\n");
}

function buildInitContainer(svc: ComposeService, name: string, parentVolumes: ComposeVolume[]): string {
  // Rewrite entrypoint to replace compose service name with localhost
  // (init container runs in same pod as parent)
  const entrypoint = svc.entrypoint
    ? svc.entrypoint.map((s) => s.replace(/http:\/\/minio:(\d+)/g, "http://localhost:$1"))
    : null;

  const lines = [
    `      - name: ${name}`,
    `        image: ${svc.image}`,
  ];

  if (entrypoint) {
    lines.push(`        command:`);
    for (const arg of entrypoint) {
      lines.push(`        - ${JSON.stringify(arg)}`);
    }
  }

  // Mount same volumes as parent so init can access the data dir
  if (parentVolumes.length > 0) {
    lines.push(`        volumeMounts:`);
    for (const vol of parentVolumes) {
      if (vol.type === "volume") {
        lines.push(`        - name: ${vol.source}`);
        lines.push(`          mountPath: ${vol.target}`);
      }
    }
  }

  return lines.join("\n");
}

function buildDeployment(
  name: string,
  svc: ComposeService,
  initSvc?: { name: string; svc: ComposeService },
): string {
  const labels = `app: ${name}\n      boilerhouse.dev/infra: "true"`;
  const matchLabels = `app: ${name}`;
  const volumes = svc.volumes ?? [];
  const namedVolumes = volumes.filter((v) => v.type === "volume");

  let containerSpec = `      containers:\n      - name: ${name}\n        image: ${svc.image}`;

  if (svc.command) {
    containerSpec += `\n        command:\n${renderCommand(svc.command)}`;
  }

  if (svc.ports && svc.ports.length > 0) {
    containerSpec += `\n        ports:\n${renderPorts(svc.ports, "        ")}`;
  }

  if (svc.environment && Object.keys(svc.environment).length > 0) {
    containerSpec += `\n        env:\n${renderEnv(svc.environment)}`;
  }

  if (namedVolumes.length > 0) {
    containerSpec += `\n        volumeMounts:`;
    for (const vol of namedVolumes) {
      containerSpec += `\n        - name: ${vol.source}\n          mountPath: ${vol.target}`;
    }
  }

  let initSpec = "";
  if (initSvc) {
    initSpec = `\n      initContainers:\n${buildInitContainer(initSvc.svc, initSvc.name, namedVolumes)}`;
  }

  let volumeSpec = "";
  if (namedVolumes.length > 0) {
    volumeSpec = `\n      volumes:`;
    for (const vol of namedVolumes) {
      volumeSpec += `\n      - name: ${vol.source}\n        emptyDir: {}`;
    }
  }

  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  labels:
    ${labels}
spec:
  replicas: 1
  selector:
    matchLabels:
      ${matchLabels}
  template:
    metadata:
      labels:
        ${labels}
    spec:${initSpec}
${containerSpec}${volumeSpec}`;
}

function buildService(name: string, ports: ComposePort[]): string {
  const labels = `app: ${name}\n    boilerhouse.dev/infra: "true"`;
  const portLines = ports
    .map(
      (p) =>
        `    - port: ${p.target}\n      targetPort: ${p.target}\n      protocol: ${p.protocol.toUpperCase()}`,
    )
    .join("\n");

  return `apiVersion: v1
kind: Service
metadata:
  name: ${name}
  labels:
    ${labels}
spec:
  selector:
    app: ${name}
  ports:
${portLines}`;
}

// ── Public API ──────────────────────────────────────────────────────────

export function generateManifests(config: ComposeConfig): string {
  const docs: string[] = [];

  // Collect init container services
  const initContainerMap = new Map<string, { name: string; svc: ComposeService }>();
  for (const [initName, parentName] of Object.entries(INIT_CONTAINERS)) {
    const initSvc = config.services[initName];
    if (initSvc) {
      initContainerMap.set(parentName, { name: initName, svc: initSvc });
    }
  }

  for (const [name, svc] of Object.entries(config.services)) {
    if (EXCLUDE.has(name)) continue;

    const initSvc = initContainerMap.get(name);
    docs.push(buildDeployment(name, svc, initSvc));

    if (svc.ports && svc.ports.length > 0) {
      docs.push(buildService(name, svc.ports));
    }
  }

  return docs.join("\n---\n");
}

// ── CLI entrypoint ──────────────────────────────────────────────────────

async function main() {
  const proc = Bun.spawn(["docker", "compose", "config", "--format", "json"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    console.error("docker compose config failed:", stderr);
    process.exit(1);
  }

  const config: ComposeConfig = JSON.parse(stdout);
  console.log(generateManifests(config));
}

// Only run main when executed directly, not when imported for tests
if (import.meta.main) {
  main();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test scripts/compose-to-k8s.test.ts`
Expected: All 10 tests PASS.

- [ ] **Step 5: Run the script against real docker-compose.yml to verify output**

Run: `bun run scripts/compose-to-k8s.ts`
Expected: Valid YAML with redis and minio Deployments + Services printed to stdout. Verify no prometheus/grafana/tempo in output.

- [ ] **Step 6: Commit**

```bash
git add scripts/compose-to-k8s.ts scripts/compose-to-k8s.test.ts
git commit -m "feat: add compose-to-k8s translator script

Reads docker-compose.yml via docker compose config --format json,
filters out observability services, and generates k8s Deployment +
Service manifests for functional deps (redis, minio)."
```

---

### Task 2: Integrate into minikube setup

**Files:**
- Modify: `.kadai/actions/minikube.sh:106-115`

- [ ] **Step 1: Add infra deployment to minikube.sh**

After the "Pulling Envoy image" block (line 109) and before the final "ready" message, add the compose-to-k8s call and readiness wait. Replace lines 111-115:

```bash
# ── Deploy infrastructure services from docker-compose.yml ────────────

echo "Deploying infrastructure services from docker-compose.yml..."
bun run "$SCRIPT_DIR/scripts/compose-to-k8s.ts" \
  | kubectl --context="$PROFILE" -n "$NAMESPACE" apply -f -

echo "Waiting for infrastructure deployments to be ready..."
kubectl --context="$PROFILE" -n "$NAMESPACE" \
  wait --for=condition=available deployment --all --timeout=120s

echo ""
echo "Minikube ready: profile=$PROFILE namespace=$NAMESPACE"
echo "  API server: $(minikube ip -p "$PROFILE"):8443"
echo "  Token:      kubectl --context=$PROFILE -n $NAMESPACE create token default"
echo "  Redis:      redis.${NAMESPACE}.svc.cluster.local:6379"
echo "  MinIO:      minio.${NAMESPACE}.svc.cluster.local:9000"
```

Also add `SCRIPT_DIR` near the top of the file, after the `NAMESPACE` line:

```bash
SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
```

- [ ] **Step 2: Verify minikube.sh still runs correctly in the already-running case**

The early-exit block (lines 57-64) fires if the cluster is already running. This path doesn't need infra deployment — it's already done. Verify that `minikube status -p boilerhouse-test` returns success (cluster is running from earlier test).

Run: `bash .kadai/actions/minikube.sh`
Expected: Prints "Cluster 'boilerhouse-test' is already running." and exits.

- [ ] **Step 3: Commit**

```bash
git add .kadai/actions/minikube.sh
git commit -m "feat: deploy compose infra deps to minikube on setup

minikube.sh now calls compose-to-k8s.ts to deploy redis and minio
into the boilerhouse namespace, then waits for readiness."
```

---

### Task 3: Set REDIS_URL for kubernetes in e2e.sh

**Files:**
- Modify: `.kadai/actions/tests/e2e.sh:44-58`

- [ ] **Step 1: Add REDIS_URL export to ensure_kubernetes function**

In `e2e.sh`, the `ensure_kubernetes` function (lines 44-58) verifies the cluster is running. After the kubectl cluster-info check, export `REDIS_URL`:

Replace the `ensure_kubernetes` function:

```bash
ensure_kubernetes() {
  local PROFILE="boilerhouse-test"
  local NAMESPACE="boilerhouse"

  if minikube status -p "$PROFILE" &>/dev/null; then
    echo "✓ Minikube cluster '$PROFILE' is running"
  else
    echo "Minikube cluster not running — starting..."
    bash "$SCRIPT_DIR/.kadai/actions/minikube.sh"
  fi

  if ! kubectl --context="$PROFILE" cluster-info &>/dev/null; then
    echo "Error: kubectl cannot reach minikube cluster" >&2
    return 1
  fi

  # Point at in-cluster infra services
  export REDIS_URL="redis://redis.${NAMESPACE}.svc.cluster.local:6379"
}
```

- [ ] **Step 2: Commit**

```bash
git add .kadai/actions/tests/e2e.sh
git commit -m "feat: set REDIS_URL for kubernetes E2E runtime

Points trigger system at in-cluster Redis deployed by minikube setup."
```

---

### Task 4: Set REDIS_URL for kubernetes in dev.sh

**Files:**
- Modify: `.kadai/actions/dev.sh:70-98`

- [ ] **Step 1: Add REDIS_URL export to kubernetes runtime block**

In `dev.sh`, the kubernetes runtime block (lines 70-99) sets up K8S env vars. After the existing exports (line 95), add:

```bash
  # In-cluster infra services
  export REDIS_URL="redis://redis.${NAMESPACE}.svc.cluster.local:6379"
```

Insert this after line 95 (`export K8S_MINIKUBE_PROFILE="$PROFILE"`) and before the echo on line 97.

- [ ] **Step 2: Commit**

```bash
git add .kadai/actions/dev.sh
git commit -m "feat: set REDIS_URL for kubernetes dev runtime

Points trigger system at in-cluster Redis when running with
kubernetes runtime in dev mode."
```

---

### Task 5: Verify end-to-end

- [ ] **Step 1: Delete and recreate minikube cluster to test full setup**

Run:
```bash
minikube delete -p boilerhouse-test
bash .kadai/actions/minikube.sh
```

Expected: Cluster starts, infra services are deployed, script waits for readiness, prints Redis/MinIO addresses.

- [ ] **Step 2: Verify pods are running in minikube**

Run:
```bash
kubectl --context=boilerhouse-test -n boilerhouse get pods
```

Expected: `redis-*` and `minio-*` pods in `Running` state.

- [ ] **Step 3: Verify services are reachable**

Run:
```bash
kubectl --context=boilerhouse-test -n boilerhouse get svc
```

Expected: `redis` service on port 6379, `minio` service on ports 9000/9001.

- [ ] **Step 4: Run unit tests to confirm nothing is broken**

Run: `bun test`
Expected: All existing unit tests pass.

- [ ] **Step 5: Run compose-to-k8s unit tests**

Run: `bun test scripts/compose-to-k8s.test.ts`
Expected: All tests pass.
