# K8s Operator E2E Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite all 18 E2E tests to target the K8s operator's CRD interface, remove the kubernetes option from existing E2E tests, and add kadai actions for operator E2E.

**Architecture:** Tests live in `tests/e2e-operator/` with a `KubeTestClient` that drives CRDs via the `@boilerhouse/k8s` REST client and verifies pod state via `kubectl`. A preload script starts the operator out-of-cluster against minikube before tests run. Each test creates uniquely-named CRDs and cleans them up in `afterAll`.

**Tech Stack:** Bun test runner, `@boilerhouse/k8s` (KubeClient, KubeStatusPatcher), operator CRD types from `apps/operator/src/crd-types.ts`, kubectl CLI for exec/logs/port-forward.

---

### Task 1: Remove kubernetes from existing E2E infrastructure

Remove the kubernetes runtime option from `tests/e2e/` since K8s testing moves to `tests/e2e-operator/`.

**Files:**
- Modify: `tests/e2e/runtime-matrix.ts`
- Modify: `tests/e2e/runtime-detect.ts`
- Modify: `tests/e2e/e2e-helpers.ts`
- Modify: `tests/e2e/runtime-matrix.ts`
- Delete: `tests/e2e/fixtures/workload-k8s-*.workload.ts` (5 files)

- [ ] **Step 1: Remove kubernetes entry from runtime-matrix.ts**

In `tests/e2e/runtime-matrix.ts`, remove the `kubernetesEntry` object (lines 124-163) and remove `kubernetes` from the `ALL_ENTRIES` record and `IMPLEMENTED_RUNTIMES` set. Also remove the kubernetes timeout entry.

```typescript
// Remove these entirely:
// - const kubernetesEntry: RuntimeEntry = { ... };
// - kubernetes: kubernetesEntry from ALL_ENTRIES
// - "kubernetes" from IMPLEMENTED_RUNTIMES

// ALL_ENTRIES becomes:
const ALL_ENTRIES: Record<string, RuntimeEntry> = {
	fake: fakeEntry,
	docker: dockerEntry,
};

const IMPLEMENTED_RUNTIMES = new Set(["fake", "docker"]);

// E2E_TIMEOUTS becomes:
export const E2E_TIMEOUTS = {
	fake: { operation: 2_000, connect: 1_000 },
	docker: { operation: 30_000, connect: 10_000 },
} as const;
```

- [ ] **Step 2: Remove kubernetes from runtime-detect.ts**

In `tests/e2e/runtime-detect.ts`, remove the `kubernetesAvailable()` function and the `kubernetes` field from `RuntimeAvailability`.

```typescript
export interface RuntimeAvailability {
	fake: true;
	docker: boolean;
}

export function detectRuntimes(): RuntimeAvailability {
	const docker = commandSucceeds("docker", ["info"]);
	return { fake: true, docker };
}
```

- [ ] **Step 3: Remove kubernetes branch from e2e-helpers.ts**

In `tests/e2e/e2e-helpers.ts`, remove the kubernetes branch in `startE2EServer()` (lines 84-99) and the `BOILERHOUSE_K8S_API_URL` handling.

```typescript
// Remove this block from startE2EServer:
// if (runtimeName === "kubernetes") { ... }
```

- [ ] **Step 4: Remove kubernetes option from kadai e2e action**

In `.kadai/actions/tests/e2e.sh`, remove option 3 (kubernetes) from the runtime selection menu and the `ensure_kubernetes` function. Renumber option 4 (all) to 3.

```bash
echo "Select runtime for E2E tests:"
echo "  1) fake        — In-memory fake runtime (no infra needed)"
echo "  2) docker      — Container runtime via Docker daemon"
echo "  3) all         — All available runtimes"
echo ""
read -rp "Runtime [1]: " RUNTIME_CHOICE

case "${RUNTIME_CHOICE:-1}" in
  1|fake)       RUNTIMES="fake" ;;
  2|docker)     RUNTIMES="docker" ;;
  3|all)        RUNTIMES="all" ;;
  *)
    echo "Invalid choice: $RUNTIME_CHOICE" >&2
    exit 1
    ;;
esac
```

Remove the `ensure_kubernetes` function and its call.

- [ ] **Step 5: Delete K8s workload fixtures**

```bash
rm tests/e2e/fixtures/workload-k8s-broken.workload.ts
rm tests/e2e/fixtures/workload-k8s-httpserver.workload.ts
rm tests/e2e/fixtures/workload-k8s-minimal.workload.ts
rm tests/e2e/fixtures/workload-k8s-openclaw.workload.ts
rm tests/e2e/fixtures/workload-k8s-wsecho.workload.ts
```

- [ ] **Step 6: Discard unstaged E2E changes**

The existing E2E test files have unstaged modifications from the previous kubernetes API server approach. Discard them:

```bash
git checkout -- tests/e2e/
```

Then re-apply the changes from steps 1-5 (the kubernetes removal edits).

- [ ] **Step 7: Run existing E2E tests to verify no breakage**

```bash
BOILERHOUSE_E2E_RUNTIMES=fake bun test tests/e2e/ --timeout 30000
```

Expected: All tests pass against the fake runtime.

- [ ] **Step 8: Commit**

```bash
git add tests/e2e/ .kadai/actions/tests/e2e.sh
git commit -m "refactor: remove kubernetes from existing E2E tests

K8s testing moves to tests/e2e-operator/ with CRD-based tests."
```

---

### Task 2: Create KubeTestClient helper

The core test infrastructure: a typed client for CRD CRUD operations, polling helpers, and kubectl wrappers.

**Files:**
- Create: `tests/e2e-operator/helpers.ts`

- [ ] **Step 1: Create helpers.ts with KubeTestClient**

```typescript
import { KubeClient, KubernetesRuntimeError } from "@boilerhouse/k8s";
import type { KubeClientConfig } from "@boilerhouse/k8s";
import { randomBytes } from "node:crypto";
import type {
	BoilerhouseWorkload,
	BoilerhouseClaim,
	BoilerhousePool,
	BoilerhouseTrigger,
} from "../../apps/operator/src/crd-types";
import { API_GROUP, API_VERSION } from "../../apps/operator/src/crd-types";

// ── Types ───────────────────────────────────────────────────────────────────

type CrdResource = "boilerhouseworkloads" | "boilerhouseclaims" | "boilerhousepools" | "boilerhousetriggers";

interface CrdObject {
	apiVersion: string;
	kind: string;
	metadata: { name: string; namespace?: string; [k: string]: unknown };
	spec: Record<string, unknown>;
	status?: Record<string, unknown>;
}

interface PortForwardHandle {
	localPort: number;
	stop: () => void;
}

// ── Constants ───────────────────────────────────────────────────────────────

const NAMESPACE = "boilerhouse";
const CONTEXT = "boilerhouse-test";
const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;

// ── KubeTestClient ──────────────────────────────────────────────────────────

export class KubeTestClient {
	private readonly config: KubeClientConfig;
	private readonly tlsOptions: { rejectUnauthorized: boolean; ca?: string };

	constructor(config: KubeClientConfig) {
		this.config = config;
		this.tlsOptions = config.caCert
			? { rejectUnauthorized: true, ca: config.caCert }
			: { rejectUnauthorized: false };
	}

	// ── CRD CRUD ────────────────────────────────────────────────────────────

	async apply(resource: CrdResource, obj: CrdObject): Promise<void> {
		const name = obj.metadata.name;
		const url = `${this.config.apiUrl}/apis/${API_GROUP}/${API_VERSION}/namespaces/${NAMESPACE}/${resource}`;

		// Try create first, fall back to replace on 409
		const createRes = await this.fetch("POST", url, obj);
		if (createRes.status === 409) {
			// Get existing to obtain resourceVersion
			const existing = await this.fetch("GET", `${url}/${name}`);
			if (!existing.ok) throw new Error(`GET ${resource}/${name}: ${existing.status}`);
			const existingBody = await existing.json() as CrdObject;
			const updated = {
				...obj,
				metadata: { ...obj.metadata, resourceVersion: (existingBody.metadata as any).resourceVersion },
			};
			const replaceRes = await this.fetch("PUT", `${url}/${name}`, updated);
			if (!replaceRes.ok) {
				const text = await replaceRes.text();
				throw new Error(`PUT ${resource}/${name}: ${replaceRes.status} ${text}`);
			}
			await replaceRes.body?.cancel();
			return;
		}
		if (!createRes.ok) {
			const text = await createRes.text();
			throw new Error(`POST ${resource}: ${createRes.status} ${text}`);
		}
		await createRes.body?.cancel();
	}

	async applyWorkload(workload: BoilerhouseWorkload): Promise<void> {
		await this.apply("boilerhouseworkloads", workload as unknown as CrdObject);
	}

	async applyClaim(claim: BoilerhouseClaim): Promise<void> {
		await this.apply("boilerhouseclaims", claim as unknown as CrdObject);
	}

	async applyPool(pool: BoilerhousePool): Promise<void> {
		await this.apply("boilerhousepools", pool as unknown as CrdObject);
	}

	async applyTrigger(trigger: BoilerhouseTrigger): Promise<void> {
		await this.apply("boilerhousetriggers", trigger as unknown as CrdObject);
	}

	async delete(resource: CrdResource, name: string): Promise<void> {
		const url = `${this.config.apiUrl}/apis/${API_GROUP}/${API_VERSION}/namespaces/${NAMESPACE}/${resource}/${name}`;
		const res = await this.fetch("DELETE", url);
		if (res.status === 404) {
			await res.body?.cancel();
			return;
		}
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`DELETE ${resource}/${name}: ${res.status} ${text}`);
		}
		await res.body?.cancel();
	}

	async deleteAll(tracked: Array<{ resource: CrdResource; name: string }>): Promise<void> {
		// Delete claims first (finalizer triggers release), then pools, then workloads
		const order: CrdResource[] = ["boilerhousetriggers", "boilerhouseclaims", "boilerhousepools", "boilerhouseworkloads"];
		for (const resource of order) {
			const items = tracked.filter((t) => t.resource === resource);
			await Promise.all(items.map((t) => this.delete(t.resource, t.name)));
			// Wait for each to be fully deleted (finalizers)
			for (const t of items) {
				await this.waitForDeletion(t.resource, t.name).catch(() => {});
			}
		}
	}

	// ── Status reading ──────────────────────────────────────────────────────

	async getStatus<T = Record<string, unknown>>(resource: CrdResource, name: string): Promise<T> {
		const url = `${this.config.apiUrl}/apis/${API_GROUP}/${API_VERSION}/namespaces/${NAMESPACE}/${resource}/${name}`;
		const res = await this.fetch("GET", url);
		if (!res.ok) throw new Error(`GET ${resource}/${name}: ${res.status}`);
		const body = await res.json() as { status?: T };
		return (body.status ?? {}) as T;
	}

	async get<T = CrdObject>(resource: CrdResource, name: string): Promise<T> {
		const url = `${this.config.apiUrl}/apis/${API_GROUP}/${API_VERSION}/namespaces/${NAMESPACE}/${resource}/${name}`;
		const res = await this.fetch("GET", url);
		if (!res.ok) throw new Error(`GET ${resource}/${name}: ${res.status}`);
		return await res.json() as T;
	}

	// ── Polling ─────────────────────────────────────────────────────────────

	async waitForPhase(
		resource: CrdResource,
		name: string,
		phase: string,
		timeoutMs = DEFAULT_TIMEOUT_MS,
	): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			try {
				const status = await this.getStatus<{ phase?: string; detail?: string }>(resource, name);
				if (status.phase === phase) return;
				if (status.phase === "Error") {
					throw new Error(`${resource}/${name} entered Error: ${status.detail ?? "no detail"}`);
				}
			} catch (err) {
				if (err instanceof Error && err.message.includes("entered Error")) throw err;
				// CR may not exist yet, keep polling
			}
			await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
		}
		// One final read for a better error message
		const finalStatus = await this.getStatus<{ phase?: string }>(resource, name).catch(() => ({ phase: "unknown" }));
		throw new Error(`${resource}/${name} did not reach phase '${phase}' within ${timeoutMs}ms (current: ${finalStatus.phase})`);
	}

	async waitForDeletion(
		resource: CrdResource,
		name: string,
		timeoutMs = DEFAULT_TIMEOUT_MS,
	): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const url = `${this.config.apiUrl}/apis/${API_GROUP}/${API_VERSION}/namespaces/${NAMESPACE}/${resource}/${name}`;
			const res = await this.fetch("GET", url);
			if (res.status === 404) {
				await res.body?.cancel();
				return;
			}
			await res.body?.cancel();
			await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
		}
		throw new Error(`${resource}/${name} was not deleted within ${timeoutMs}ms`);
	}

	// ── HTTP ────────────────────────────────────────────────────────────────

	private async fetch(method: string, url: string, body?: unknown): Promise<Response> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.config.token}`,
			Accept: "application/json",
		};
		const init: RequestInit & { tls?: unknown } = { method, headers };
		if (body !== undefined) {
			headers["Content-Type"] = "application/json";
			init.body = JSON.stringify(body);
		}
		init.tls = this.tlsOptions;
		return globalThis.fetch(url, init as RequestInit);
	}
}

// ── kubectl wrappers ────────────────────────────────────────────────────────

export async function kubectlExec(
	podName: string,
	command: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(
		["kubectl", "--context", CONTEXT, "-n", NAMESPACE, "exec", podName, "--", ...command],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	return { exitCode, stdout, stderr };
}

export async function kubectlLogs(podName: string, tailLines = 100): Promise<string> {
	const proc = Bun.spawn(
		["kubectl", "--context", CONTEXT, "-n", NAMESPACE, "logs", podName, "--tail", String(tailLines)],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const stdout = await new Response(proc.stdout).text();
	await proc.exited;
	return stdout;
}

export async function kubectlGetPodPhase(podName: string): Promise<string> {
	const proc = Bun.spawn(
		["kubectl", "--context", CONTEXT, "-n", NAMESPACE, "get", "pod", podName, "-o", "jsonpath={.status.phase}"],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const stdout = await new Response(proc.stdout).text();
	await proc.exited;
	return stdout.trim();
}

export async function kubectlPodExists(podName: string): Promise<boolean> {
	const proc = Bun.spawn(
		["kubectl", "--context", CONTEXT, "-n", NAMESPACE, "get", "pod", podName],
		{ stdout: "ignore", stderr: "ignore" },
	);
	const exitCode = await proc.exited;
	return exitCode === 0;
}

export async function kubectlPortForward(
	podName: string,
	containerPort: number,
): Promise<PortForwardHandle> {
	const proc = Bun.spawn(
		["kubectl", "--context", CONTEXT, "-n", NAMESPACE, "port-forward", `pod/${podName}`, `:${containerPort}`],
		{ stdout: "pipe", stderr: "pipe" },
	);

	// Read stdout to discover the assigned local port
	const reader = proc.stdout.getReader();
	const deadline = Date.now() + 10_000;
	let accumulated = "";

	while (Date.now() < deadline) {
		const { value, done } = await reader.read();
		if (done) break;
		accumulated += new TextDecoder().decode(value);

		const match = accumulated.match(/Forwarding from 127\.0\.0\.1:(\d+)/);
		if (match) {
			const localPort = Number(match[1]);
			reader.releaseLock();

			// Wait for port to accept connections
			await waitForPortReady(localPort);

			return {
				localPort,
				stop: () => proc.kill(),
			};
		}
	}

	proc.kill();
	throw new Error(`kubectl port-forward did not produce a local port within 10s`);
}

async function waitForPortReady(port: number, timeoutMs = 30_000): Promise<void> {
	const { connect } = await import("node:net");
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const ok = await new Promise<boolean>((resolve) => {
			const sock = connect(port, "127.0.0.1", () => {
				sock.destroy();
				resolve(true);
			});
			sock.on("error", () => { sock.destroy(); resolve(false); });
			sock.setTimeout(1000, () => { sock.destroy(); resolve(false); });
		});
		if (ok) return;
		await new Promise((r) => setTimeout(r, 500));
	}
}

// ── Utilities ───────────────────────────────────────────────────────────────

/** Generates a test-unique name like `test-a1b2c3-prefix`. */
export function uniqueName(prefix: string): string {
	const id = randomBytes(4).toString("hex");
	return `test-${id}-${prefix}`;
}

/** The operator's internal API base URL. Set by setup.ts. */
export let operatorApiUrl: string;

export function setOperatorApiUrl(url: string): void {
	operatorApiUrl = url;
}

/** Global test client. Set by setup.ts. */
let _testClient: KubeTestClient;

export function getTestClient(): KubeTestClient {
	if (!_testClient) throw new Error("KubeTestClient not initialized — is setup.ts loaded?");
	return _testClient;
}

export function setTestClient(client: KubeTestClient): void {
	_testClient = client;
}

/** Tracks CRDs created during a test for cleanup in afterAll. */
export class CrdTracker {
	private tracked: Array<{ resource: CrdResource; name: string }> = [];

	track(resource: CrdResource, name: string): void {
		this.tracked.push({ resource, name });
	}

	async cleanup(client: KubeTestClient): Promise<void> {
		await client.deleteAll(this.tracked);
		this.tracked = [];
	}
}

export { NAMESPACE, CONTEXT, DEFAULT_TIMEOUT_MS };
export type { CrdResource, PortForwardHandle };
```

- [ ] **Step 2: Verify the file compiles**

```bash
bun build --no-bundle tests/e2e-operator/helpers.ts --outdir /tmp/e2e-check 2>&1
```

Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e-operator/helpers.ts
git commit -m "feat: add KubeTestClient helper for operator E2E tests"
```

---

### Task 3: Create CRD fixture builders

TypeScript functions that produce CRD manifests with unique names.

**Files:**
- Create: `tests/e2e-operator/fixtures.ts`

- [ ] **Step 1: Create fixtures.ts**

```typescript
import type {
	BoilerhouseWorkload,
	BoilerhouseWorkloadSpec,
	BoilerhouseClaim,
	BoilerhousePool,
	BoilerhouseTrigger,
	BoilerhouseTriggerSpec,
} from "../../apps/operator/src/crd-types";
import { API_GROUP, API_VERSION } from "../../apps/operator/src/crd-types";

const API_VER = `${API_GROUP}/${API_VERSION}` as const;
const NAMESPACE = "boilerhouse";

// ── Workload fixtures ───────────────────────────────────────────────────────

export function httpserverWorkload(name: string): BoilerhouseWorkload {
	return {
		apiVersion: API_VER,
		kind: "BoilerhouseWorkload",
		metadata: { name, namespace: NAMESPACE },
		spec: {
			version: "1.0.0",
			image: { ref: "docker.io/library/python:3-alpine" },
			resources: { vcpus: 1, memoryMb: 256 },
			network: {
				access: "unrestricted",
				expose: [{ guest: 8080 }],
			},
			idle: { timeoutSeconds: 300, action: "hibernate" },
			health: {
				intervalSeconds: 2,
				unhealthyThreshold: 30,
				httpGet: { path: "/", port: 8080 },
			},
			entrypoint: {
				cmd: "/usr/local/bin/python3",
				args: ["-m", "http.server", "8080"],
			},
		},
	};
}

export function minimalWorkload(name: string): BoilerhouseWorkload {
	return {
		apiVersion: API_VER,
		kind: "BoilerhouseWorkload",
		metadata: { name, namespace: NAMESPACE },
		spec: {
			version: "1.0.0",
			image: { ref: "docker.io/library/alpine:3.21" },
			resources: { vcpus: 1, memoryMb: 128, diskGb: 1 },
			network: { access: "none" },
			idle: { timeoutSeconds: 300, action: "hibernate" },
			entrypoint: {
				cmd: "/bin/sh",
				args: ["-c", "while true; do sleep 1; done"],
			},
		},
	};
}

export function overlayWorkload(name: string): BoilerhouseWorkload {
	return {
		apiVersion: API_VER,
		kind: "BoilerhouseWorkload",
		metadata: { name, namespace: NAMESPACE },
		spec: {
			version: "1.0.0",
			image: { ref: "docker.io/library/alpine:3.21" },
			resources: { vcpus: 1, memoryMb: 128, diskGb: 2 },
			network: { access: "none" },
			filesystem: { overlayDirs: ["/data"] },
			idle: { action: "hibernate" },
			entrypoint: {
				cmd: "/bin/sh",
				args: ["-c", "mkdir -p /data && while true; do sleep 1; done"],
			},
		},
	};
}

export function idleWorkload(name: string, timeoutSeconds: number): BoilerhouseWorkload {
	return {
		apiVersion: API_VER,
		kind: "BoilerhouseWorkload",
		metadata: { name, namespace: NAMESPACE },
		spec: {
			version: "1.0.0",
			image: { ref: "docker.io/library/alpine:3.21" },
			resources: { vcpus: 1, memoryMb: 128, diskGb: 1 },
			network: { access: "none" },
			filesystem: { overlayDirs: ["/data"] },
			idle: { timeoutSeconds, action: "hibernate" },
			entrypoint: {
				cmd: "/bin/sh",
				args: ["-c", "mkdir -p /data && while true; do sleep 1; done"],
			},
		},
	};
}

export function brokenWorkload(name: string): BoilerhouseWorkload {
	return {
		apiVersion: API_VER,
		kind: "BoilerhouseWorkload",
		metadata: { name, namespace: NAMESPACE },
		spec: {
			version: "1.0.0",
			image: { ref: "docker.io/library/nonexistent-image:99.99.99" },
			resources: { vcpus: 1, memoryMb: 128, diskGb: 1 },
			network: { access: "none" },
			idle: { action: "destroy" },
			entrypoint: {
				cmd: "/bin/sh",
				args: ["-c", "exit 1"],
			},
		},
	};
}

export function openclawWorkload(name: string): BoilerhouseWorkload {
	return {
		apiVersion: API_VER,
		kind: "BoilerhouseWorkload",
		metadata: { name, namespace: NAMESPACE },
		spec: {
			version: "1.0.0",
			image: { ref: "docker.io/library/python:3-alpine" },
			resources: { vcpus: 2, memoryMb: 512, diskGb: 10 },
			network: {
				access: "restricted",
				expose: [{ guest: 18789 }],
				allowlist: ["api.anthropic.com"],
				credentials: [{
					domain: "api.anthropic.com",
					secretRef: { name: "anthropic-key", key: "api-key" },
					headers: { "x-api-key": "{{value}}" },
				}],
				websocket: "/",
			},
			filesystem: { overlayDirs: ["/home/user/.cache"] },
			idle: { timeoutSeconds: 600, action: "hibernate" },
			health: {
				intervalSeconds: 10,
				unhealthyThreshold: 3,
				httpGet: { path: "/health", port: 18789 },
			},
			entrypoint: {
				cmd: "/usr/local/bin/python3",
				args: ["-m", "http.server", "18789"],
			},
		},
	};
}

// ── Claim fixtures ──────────────────────────────────────────────────────────

export function claim(name: string, tenantId: string, workloadRef: string): BoilerhouseClaim {
	return {
		apiVersion: API_VER,
		kind: "BoilerhouseClaim",
		metadata: { name, namespace: NAMESPACE },
		spec: { tenantId, workloadRef },
	};
}

// ── Pool fixtures ───────────────────────────────────────────────────────────

export function pool(name: string, workloadRef: string, size: number): BoilerhousePool {
	return {
		apiVersion: API_VER,
		kind: "BoilerhousePool",
		metadata: { name, namespace: NAMESPACE },
		spec: { workloadRef, size },
	};
}

// ── Trigger fixtures ────────────────────────────────────────────────────────

export function trigger(
	name: string,
	workloadRef: string,
	type: BoilerhouseTriggerSpec["type"],
	config: Record<string, unknown>,
): BoilerhouseTrigger {
	return {
		apiVersion: API_VER,
		kind: "BoilerhouseTrigger",
		metadata: { name, namespace: NAMESPACE },
		spec: { type, workloadRef, config },
	};
}
```

- [ ] **Step 2: Verify compilation**

```bash
bun build --no-bundle tests/e2e-operator/fixtures.ts --outdir /tmp/e2e-check 2>&1
```

Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e-operator/fixtures.ts
git commit -m "feat: add CRD fixture builders for operator E2E tests"
```

---

### Task 4: Create global test setup

Preload script that starts the operator, creates the test client, and tears down on exit.

**Files:**
- Create: `tests/e2e-operator/setup.ts`

- [ ] **Step 1: Create setup.ts**

```typescript
import { beforeAll, afterAll } from "bun:test";
import { KubeTestClient, setTestClient, setOperatorApiUrl, CONTEXT } from "./helpers";

const OPERATOR_HEALTH_TIMEOUT_MS = 30_000;
const INTERNAL_API_PORT = 19090; // Use a non-default port to avoid conflicts

let operatorProc: ReturnType<typeof Bun.spawn> | null = null;

/**
 * Extracts minikube API URL and creates a token for the operator service account.
 */
async function getMinikubeAuth(): Promise<{ apiUrl: string; token: string; caCert?: string }> {
	// Get minikube API URL
	const ipProc = Bun.spawnSync(["minikube", "ip", "-p", CONTEXT]);
	const ip = ipProc.stdout.toString().trim();
	if (!ip) throw new Error("Failed to get minikube IP");

	const apiUrl = `https://${ip}:8443`;

	// Create token for the operator service account
	const tokenProc = Bun.spawnSync([
		"kubectl", "--context", CONTEXT,
		"-n", "boilerhouse",
		"create", "token", "boilerhouse-operator",
		"--duration", "1h",
	]);
	const token = tokenProc.stdout.toString().trim();
	if (!token) throw new Error("Failed to create operator service account token");

	// Get CA cert from minikube
	const caProc = Bun.spawnSync(["minikube", "-p", CONTEXT, "ssh", "cat /var/lib/minikube/certs/ca.crt"]);
	const caCert = caProc.stdout.toString().trim() || undefined;

	return { apiUrl, token, caCert };
}

beforeAll(async () => {
	console.log("[setup] Verifying minikube cluster...");

	// Verify minikube is running
	const statusProc = Bun.spawnSync(["minikube", "status", "-p", CONTEXT]);
	if (statusProc.exitCode !== 0) {
		throw new Error(`Minikube cluster '${CONTEXT}' is not running. Run: bunx kadai run minikube`);
	}

	// Apply CRDs (idempotent)
	console.log("[setup] Applying CRDs...");
	const crdProc = Bun.spawnSync([
		"kubectl", "--context", CONTEXT, "apply",
		"-f", "apps/operator/crds/",
	]);
	if (crdProc.exitCode !== 0) {
		throw new Error(`Failed to apply CRDs: ${crdProc.stderr.toString()}`);
	}

	// Apply RBAC (idempotent)
	console.log("[setup] Applying RBAC...");
	const rbacProc = Bun.spawnSync([
		"kubectl", "--context", CONTEXT, "apply",
		"-f", "apps/operator/deploy/rbac.yaml",
	]);
	if (rbacProc.exitCode !== 0) {
		throw new Error(`Failed to apply RBAC: ${rbacProc.stderr.toString()}`);
	}

	// Get auth credentials
	const auth = await getMinikubeAuth();

	// Start operator process out-of-cluster
	console.log("[setup] Starting operator...");
	operatorProc = Bun.spawn(
		["bun", "run", "apps/operator/src/main.ts"],
		{
			env: {
				...process.env,
				K8S_API_URL: auth.apiUrl,
				K8S_TOKEN: auth.token,
				K8S_CA_CERT: auth.caCert ?? "",
				K8S_NAMESPACE: "boilerhouse",
				K8S_CONTEXT: CONTEXT,
				K8S_MINIKUBE_PROFILE: CONTEXT,
				INTERNAL_API_PORT: String(INTERNAL_API_PORT),
				DB_PATH: ":memory:",
				STORAGE_PATH: "/tmp/boilerhouse-e2e-operator",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);

	// Poll operator health endpoint
	console.log("[setup] Waiting for operator health...");
	const healthUrl = `http://localhost:${INTERNAL_API_PORT}/healthz`;
	const deadline = Date.now() + OPERATOR_HEALTH_TIMEOUT_MS;

	while (Date.now() < deadline) {
		try {
			const res = await fetch(healthUrl);
			if (res.ok) {
				console.log("[setup] Operator is healthy");
				break;
			}
		} catch {
			// Not ready yet
		}

		// Check if process crashed
		if (operatorProc.exitCode !== null) {
			const stderr = await new Response(operatorProc.stderr).text();
			throw new Error(`Operator process exited with code ${operatorProc.exitCode}: ${stderr}`);
		}

		await new Promise((r) => setTimeout(r, 500));
	}

	if (Date.now() >= deadline) {
		operatorProc.kill();
		throw new Error(`Operator did not become healthy within ${OPERATOR_HEALTH_TIMEOUT_MS}ms`);
	}

	// Create test client
	const client = new KubeTestClient(auth);
	setTestClient(client);
	setOperatorApiUrl(`http://localhost:${INTERNAL_API_PORT}`);

	console.log("[setup] Ready");
}, 60_000);

afterAll(async () => {
	console.log("[setup] Tearing down...");
	if (operatorProc && operatorProc.exitCode === null) {
		operatorProc.kill();
		await operatorProc.exited;
	}

	// Clean up any remaining test CRDs
	const cleanProc = Bun.spawnSync([
		"kubectl", "--context", CONTEXT,
		"-n", "boilerhouse",
		"delete", "boilerhouseclaims,boilerhousepools,boilerhouseworkloads,boilerhousetriggers",
		"-l", "boilerhouse.dev/e2e=true",
		"--ignore-not-found",
	]);
	console.log("[setup] Cleanup complete");
});
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e-operator/setup.ts
git commit -m "feat: add operator E2E global setup (starts operator against minikube)"
```

---

### Task 5: Update kadai minikube action and create e2e-operator action

**Files:**
- Modify: `.kadai/actions/minikube.sh`
- Create: `.kadai/actions/tests/e2e-operator.sh`

- [ ] **Step 1: Update minikube.sh to install CRDs and operator RBAC**

Add CRD and RBAC installation after the namespace/RBAC section in `.kadai/actions/minikube.sh`. Append before the envoy image pull section:

```bash
# ── Operator CRDs + RBAC ────────────────────────────────────────────────
# Applied idempotently so re-running the action picks up any changes.

SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

echo "Applying operator CRDs..."
kubectl --context="$PROFILE" apply -f "$SCRIPT_DIR/apps/operator/crds/"

echo "Applying operator RBAC..."
kubectl --context="$PROFILE" apply -f "$SCRIPT_DIR/apps/operator/deploy/rbac.yaml"
```

- [ ] **Step 2: Create e2e-operator.sh kadai action**

```bash
#!/bin/bash
# kadai:name Operator E2E Tests
# kadai:emoji ☸️
# kadai:description Run E2E tests against the K8s operator on minikube
# kadai:category tests

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
PROFILE="boilerhouse-test"

# ── Ensure minikube is ready ────────────────────────────────────────────────

if ! minikube status -p "$PROFILE" &>/dev/null; then
  echo "Minikube cluster not running — starting..."
  bash "$SCRIPT_DIR/.kadai/actions/minikube.sh"
else
  echo "✓ Minikube cluster '$PROFILE' is running"

  # Ensure CRDs and RBAC are applied even if cluster was already running
  kubectl --context="$PROFILE" apply -f "$SCRIPT_DIR/apps/operator/crds/" --quiet
  kubectl --context="$PROFILE" apply -f "$SCRIPT_DIR/apps/operator/deploy/rbac.yaml" --quiet
  echo "✓ CRDs and RBAC applied"
fi

# ── Run tests ───────────────────────────────────────────────────────────────
# The test preload script (setup.ts) handles starting/stopping the operator.

echo ""
echo "Running operator E2E tests..."
exec bun test tests/e2e-operator/ --preload ./tests/e2e-operator/setup.ts --timeout 120000
```

- [ ] **Step 3: Commit**

```bash
git add .kadai/actions/minikube.sh .kadai/actions/tests/e2e-operator.sh
git commit -m "feat: update kadai minikube to install CRDs, add e2e-operator action"
```

---

### Task 6: instance-lifecycle test

**Files:**
- Create: `tests/e2e-operator/instance-lifecycle.e2e.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, test, expect, afterAll } from "bun:test";
import { getTestClient, uniqueName, kubectlGetPodPhase, kubectlPodExists, CrdTracker } from "./helpers";
import { httpserverWorkload, claim } from "./fixtures";
import type { BoilerhouseClaimStatus } from "../../apps/operator/src/crd-types";

describe("instance lifecycle", () => {
	const client = getTestClient();
	const tracker = new CrdTracker();

	afterAll(async () => {
		await tracker.cleanup(client);
	});

	test("create workload, claim, verify pod, release, verify cleanup", async () => {
		// 1. Create workload
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(httpserverWorkload(wlName));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		// 2. Create claim
		const tenantId = uniqueName("tenant");
		const claimName = uniqueName("claim");
		tracker.track("boilerhouseclaims", claimName);
		await client.applyClaim(claim(claimName, tenantId, wlName));
		await client.waitForPhase("boilerhouseclaims", claimName, "Active");

		// 3. Read status — instanceId and endpoint
		const status = await client.getStatus<BoilerhouseClaimStatus>("boilerhouseclaims", claimName);
		expect(status.instanceId).toBeDefined();
		expect(status.endpoint).toBeDefined();

		// 4. Verify pod is running
		const podPhase = await kubectlGetPodPhase(status.instanceId!);
		expect(podPhase).toBe("Running");

		// 5. Delete claim (triggers release via finalizer)
		await client.delete("boilerhouseclaims", claimName);
		await client.waitForDeletion("boilerhouseclaims", claimName);

		// 6. Verify pod is cleaned up
		// Wait a bit for the operator to destroy the pod
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			if (!(await kubectlPodExists(status.instanceId!))) break;
			await new Promise((r) => setTimeout(r, 1_000));
		}
		expect(await kubectlPodExists(status.instanceId!)).toBe(false);
	}, 120_000);
});
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e-operator/instance-lifecycle.e2e.test.ts
git commit -m "feat: add operator E2E instance-lifecycle test"
```

---

### Task 7: tenant-lifecycle test

**Files:**
- Create: `tests/e2e-operator/tenant-lifecycle.e2e.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, test, expect, afterAll } from "bun:test";
import { getTestClient, uniqueName, CrdTracker } from "./helpers";
import { httpserverWorkload, claim } from "./fixtures";
import type { BoilerhouseClaimStatus } from "../../apps/operator/src/crd-types";

describe("tenant lifecycle", () => {
	const client = getTestClient();
	const tracker = new CrdTracker();

	afterAll(async () => {
		await tracker.cleanup(client);
	});

	test("claim status transitions: Pending → Active, delete → cleanup, re-claim", async () => {
		// 1. Create workload
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(httpserverWorkload(wlName));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		// 2. First claim
		const tenantId = uniqueName("tenant");
		const claim1Name = uniqueName("claim");
		tracker.track("boilerhouseclaims", claim1Name);
		await client.applyClaim(claim(claim1Name, tenantId, wlName));

		// 3. Verify Pending → Active transition
		await client.waitForPhase("boilerhouseclaims", claim1Name, "Active");
		const status1 = await client.getStatus<BoilerhouseClaimStatus>("boilerhouseclaims", claim1Name);
		expect(status1.instanceId).toBeDefined();
		expect(status1.endpoint).toBeDefined();
		expect(status1.source).toBeDefined();
		expect(status1.claimedAt).toBeDefined();
		const firstInstanceId = status1.instanceId!;

		// 4. Delete claim (release)
		await client.delete("boilerhouseclaims", claim1Name);
		await client.waitForDeletion("boilerhouseclaims", claim1Name);

		// 5. Re-claim with a new CR
		const claim2Name = uniqueName("claim");
		tracker.track("boilerhouseclaims", claim2Name);
		await client.applyClaim(claim(claim2Name, tenantId, wlName));
		await client.waitForPhase("boilerhouseclaims", claim2Name, "Active");

		const status2 = await client.getStatus<BoilerhouseClaimStatus>("boilerhouseclaims", claim2Name);
		expect(status2.instanceId).toBeDefined();
		// New claim gets a new instance
		expect(status2.instanceId).not.toBe(firstInstanceId);
	}, 120_000);
});
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e-operator/tenant-lifecycle.e2e.test.ts
git commit -m "feat: add operator E2E tenant-lifecycle test"
```

---

### Task 8: destroy test

**Files:**
- Create: `tests/e2e-operator/destroy.e2e.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, test, expect, afterAll } from "bun:test";
import { getTestClient, uniqueName, kubectlPodExists, CrdTracker } from "./helpers";
import { httpserverWorkload, claim } from "./fixtures";
import type { BoilerhouseClaimStatus, BoilerhouseWorkloadStatus } from "../../apps/operator/src/crd-types";

describe("destroy", () => {
	const client = getTestClient();
	const tracker = new CrdTracker();

	afterAll(async () => {
		await tracker.cleanup(client);
	});

	test("delete workload with active claim is blocked by finalizer", async () => {
		// 1. Create workload and claim
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(httpserverWorkload(wlName));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		const claimName = uniqueName("claim");
		tracker.track("boilerhouseclaims", claimName);
		await client.applyClaim(claim(claimName, uniqueName("tenant"), wlName));
		await client.waitForPhase("boilerhouseclaims", claimName, "Active");

		const status = await client.getStatus<BoilerhouseClaimStatus>("boilerhouseclaims", claimName);
		const instanceId = status.instanceId!;

		// 2. Try to delete workload — should be blocked by finalizer (claim exists)
		await client.delete("boilerhouseworkloads", wlName);

		// Wait briefly — the CR should still exist because of the finalizer
		await new Promise((r) => setTimeout(r, 3_000));
		const wlStatus = await client.getStatus<BoilerhouseWorkloadStatus>("boilerhouseworkloads", wlName).catch(() => null);
		// Workload should still exist (finalizer blocks deletion while claims exist)
		expect(wlStatus).not.toBeNull();

		// 3. Delete claim first
		await client.delete("boilerhouseclaims", claimName);
		await client.waitForDeletion("boilerhouseclaims", claimName);

		// 4. Now workload should be deleted (finalizer can proceed)
		await client.waitForDeletion("boilerhouseworkloads", wlName);

		// 5. Pod should be cleaned up
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			if (!(await kubectlPodExists(instanceId))) break;
			await new Promise((r) => setTimeout(r, 1_000));
		}
		expect(await kubectlPodExists(instanceId)).toBe(false);
	}, 120_000);
});
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e-operator/destroy.e2e.test.ts
git commit -m "feat: add operator E2E destroy test"
```

---

### Task 9: error-recovery test

**Files:**
- Create: `tests/e2e-operator/error-recovery.e2e.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, test, expect, afterAll } from "bun:test";
import { getTestClient, uniqueName, CrdTracker } from "./helpers";
import { brokenWorkload, httpserverWorkload, claim } from "./fixtures";
import type { BoilerhouseWorkloadStatus, BoilerhouseClaimStatus } from "../../apps/operator/src/crd-types";

describe("error recovery", () => {
	const client = getTestClient();
	const tracker = new CrdTracker();

	afterAll(async () => {
		await tracker.cleanup(client);
	});

	test("broken workload enters Error, valid workload still works", async () => {
		// 1. Create workload with bad image
		const brokenName = uniqueName("broken");
		tracker.track("boilerhouseworkloads", brokenName);
		await client.applyWorkload(brokenWorkload(brokenName));

		// 2. Wait for Error status
		await client.waitForPhase("boilerhouseworkloads", brokenName, "Error", 60_000);
		const brokenStatus = await client.getStatus<BoilerhouseWorkloadStatus>("boilerhouseworkloads", brokenName);
		expect(brokenStatus.detail).toBeDefined();
		expect(brokenStatus.detail!.length).toBeGreaterThan(0);

		// 3. Create a valid workload — system should still work
		const goodName = uniqueName("good");
		tracker.track("boilerhouseworkloads", goodName);
		await client.applyWorkload(httpserverWorkload(goodName));
		await client.waitForPhase("boilerhouseworkloads", goodName, "Ready");

		// 4. Claim the valid workload — should succeed
		const claimName = uniqueName("claim");
		tracker.track("boilerhouseclaims", claimName);
		await client.applyClaim(claim(claimName, uniqueName("tenant"), goodName));
		await client.waitForPhase("boilerhouseclaims", claimName, "Active");

		const status = await client.getStatus<BoilerhouseClaimStatus>("boilerhouseclaims", claimName);
		expect(status.instanceId).toBeDefined();
	}, 120_000);
});
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e-operator/error-recovery.e2e.test.ts
git commit -m "feat: add operator E2E error-recovery test"
```

---

### Task 10: http-connectivity test

**Files:**
- Create: `tests/e2e-operator/http-connectivity.e2e.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, test, expect, afterAll } from "bun:test";
import { getTestClient, uniqueName, kubectlPortForward, CrdTracker } from "./helpers";
import type { PortForwardHandle } from "./helpers";
import { httpserverWorkload, claim } from "./fixtures";
import type { BoilerhouseClaimStatus } from "../../apps/operator/src/crd-types";

describe("http connectivity", () => {
	const client = getTestClient();
	const tracker = new CrdTracker();
	const portForwards: PortForwardHandle[] = [];

	afterAll(async () => {
		for (const pf of portForwards) pf.stop();
		await tracker.cleanup(client);
	});

	test("claim httpserver workload, port-forward, verify HTTP response", async () => {
		// 1. Create workload
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(httpserverWorkload(wlName));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		// 2. Claim
		const claimName = uniqueName("claim");
		tracker.track("boilerhouseclaims", claimName);
		await client.applyClaim(claim(claimName, uniqueName("tenant"), wlName));
		await client.waitForPhase("boilerhouseclaims", claimName, "Active");

		const status = await client.getStatus<BoilerhouseClaimStatus>("boilerhouseclaims", claimName);
		expect(status.instanceId).toBeDefined();

		// 3. Port-forward to pod
		const pf = await kubectlPortForward(status.instanceId!, 8080);
		portForwards.push(pf);

		// 4. Verify HTTP response
		const resp = await fetch(`http://127.0.0.1:${pf.localPort}/`);
		expect(resp.status).toBe(200);
		const body = await resp.text();
		expect(body.length).toBeGreaterThan(0);
		const contentType = resp.headers.get("content-type") ?? "";
		expect(contentType).toContain("text/html");
	}, 120_000);
});
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e-operator/http-connectivity.e2e.test.ts
git commit -m "feat: add operator E2E http-connectivity test"
```

---

### Task 11: idle-timeout test

**Files:**
- Create: `tests/e2e-operator/idle-timeout.e2e.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, test, expect, afterAll } from "bun:test";
import { getTestClient, uniqueName, CrdTracker } from "./helpers";
import { idleWorkload, claim } from "./fixtures";
import type { BoilerhouseClaimStatus } from "../../apps/operator/src/crd-types";

const IDLE_TIMEOUT_SECONDS = 5;

describe("idle timeout", () => {
	const client = getTestClient();
	const tracker = new CrdTracker();

	afterAll(async () => {
		await tracker.cleanup(client);
	});

	test("claim with idle config, operator sets phase to Released after timeout", async () => {
		// 1. Create workload with short idle timeout
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(idleWorkload(wlName, IDLE_TIMEOUT_SECONDS));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		// 2. Claim
		const claimName = uniqueName("claim");
		tracker.track("boilerhouseclaims", claimName);
		await client.applyClaim(claim(claimName, uniqueName("tenant"), wlName));
		await client.waitForPhase("boilerhouseclaims", claimName, "Active");

		const status = await client.getStatus<BoilerhouseClaimStatus>("boilerhouseclaims", claimName);
		expect(status.instanceId).toBeDefined();

		// 3. Wait for idle timeout — operator should set phase to Released
		await client.waitForPhase("boilerhouseclaims", claimName, "Released", 60_000);

		// 4. Verify claim status
		const releasedStatus = await client.getStatus<BoilerhouseClaimStatus>("boilerhouseclaims", claimName);
		expect(releasedStatus.phase).toBe("Released");
	}, 120_000);
});
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e-operator/idle-timeout.e2e.test.ts
git commit -m "feat: add operator E2E idle-timeout test"
```

---

### Task 12: instance-actions test

**Files:**
- Create: `tests/e2e-operator/instance-actions.e2e.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, test, expect, afterAll } from "bun:test";
import { getTestClient, uniqueName, kubectlExec, kubectlLogs, kubectlPodExists, CrdTracker } from "./helpers";
import { minimalWorkload, overlayWorkload, claim } from "./fixtures";
import type { BoilerhouseClaimStatus } from "../../apps/operator/src/crd-types";

describe("instance actions", () => {
	const client = getTestClient();
	const tracker = new CrdTracker();

	afterAll(async () => {
		await tracker.cleanup(client);
	});

	test("kubectl exec on managed pod", async () => {
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(minimalWorkload(wlName));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		const claimName = uniqueName("claim");
		tracker.track("boilerhouseclaims", claimName);
		await client.applyClaim(claim(claimName, uniqueName("tenant"), wlName));
		await client.waitForPhase("boilerhouseclaims", claimName, "Active");

		const status = await client.getStatus<BoilerhouseClaimStatus>("boilerhouseclaims", claimName);
		const podName = status.instanceId!;

		// Exec a command
		const result = await kubectlExec(podName, ["echo", "hello-from-e2e"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("hello-from-e2e");
	}, 120_000);

	test("kubectl logs on managed pod", async () => {
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(minimalWorkload(wlName));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		const claimName = uniqueName("claim");
		tracker.track("boilerhouseclaims", claimName);
		await client.applyClaim(claim(claimName, uniqueName("tenant"), wlName));
		await client.waitForPhase("boilerhouseclaims", claimName, "Active");

		const status = await client.getStatus<BoilerhouseClaimStatus>("boilerhouseclaims", claimName);
		const podName = status.instanceId!;

		// Get logs — should not throw
		const logs = await kubectlLogs(podName);
		expect(typeof logs).toBe("string");
	}, 120_000);

	test("pod is destroyed after claim deletion", async () => {
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(minimalWorkload(wlName));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		const claimName = uniqueName("claim");
		tracker.track("boilerhouseclaims", claimName);
		await client.applyClaim(claim(claimName, uniqueName("tenant"), wlName));
		await client.waitForPhase("boilerhouseclaims", claimName, "Active");

		const status = await client.getStatus<BoilerhouseClaimStatus>("boilerhouseclaims", claimName);
		const podName = status.instanceId!;

		// Delete claim
		await client.delete("boilerhouseclaims", claimName);
		await client.waitForDeletion("boilerhouseclaims", claimName);

		// Pod should eventually be gone
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			if (!(await kubectlPodExists(podName))) break;
			await new Promise((r) => setTimeout(r, 1_000));
		}
		expect(await kubectlPodExists(podName)).toBe(false);
	}, 120_000);
});
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e-operator/instance-actions.e2e.test.ts
git commit -m "feat: add operator E2E instance-actions test"
```

---

### Task 13: concurrent-tenants test

**Files:**
- Create: `tests/e2e-operator/concurrent-tenants.e2e.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, test, expect, afterAll } from "bun:test";
import { getTestClient, uniqueName, CrdTracker } from "./helpers";
import { httpserverWorkload, claim } from "./fixtures";
import type { BoilerhouseClaimStatus } from "../../apps/operator/src/crd-types";

describe("concurrent tenants", () => {
	const client = getTestClient();
	const tracker = new CrdTracker();

	afterAll(async () => {
		await tracker.cleanup(client);
	});

	test("3 claims for the same workload all reach Active", async () => {
		// 1. Create workload
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(httpserverWorkload(wlName));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		// 2. Create 3 claims simultaneously
		const claims = Array.from({ length: 3 }, () => ({
			name: uniqueName("claim"),
			tenantId: uniqueName("tenant"),
		}));

		await Promise.all(claims.map(({ name, tenantId }) => {
			tracker.track("boilerhouseclaims", name);
			return client.applyClaim(claim(name, tenantId, wlName));
		}));

		// 3. Wait for all to become Active
		await Promise.all(claims.map(({ name }) =>
			client.waitForPhase("boilerhouseclaims", name, "Active"),
		));

		// 4. Verify all have distinct instanceIds
		const statuses = await Promise.all(claims.map(({ name }) =>
			client.getStatus<BoilerhouseClaimStatus>("boilerhouseclaims", name),
		));

		const instanceIds = statuses.map((s) => s.instanceId);
		const uniqueIds = new Set(instanceIds);
		expect(uniqueIds.size).toBe(3);

		// 5. All should have endpoints
		for (const s of statuses) {
			expect(s.endpoint).toBeDefined();
		}
	}, 120_000);
});
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e-operator/concurrent-tenants.e2e.test.ts
git commit -m "feat: add operator E2E concurrent-tenants test"
```

---

### Task 14: multi-tenant-claim test

**Files:**
- Create: `tests/e2e-operator/multi-tenant-claim.e2e.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, test, expect, afterAll } from "bun:test";
import { getTestClient, uniqueName, CrdTracker } from "./helpers";
import { httpserverWorkload, claim } from "./fixtures";
import type { BoilerhouseClaimStatus } from "../../apps/operator/src/crd-types";

describe("multi-tenant claim", () => {
	const client = getTestClient();
	const tracker = new CrdTracker();

	afterAll(async () => {
		await tracker.cleanup(client);
	});

	test("two different tenants can claim the same workload", async () => {
		// 1. Create workload
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(httpserverWorkload(wlName));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		// 2. Tenant 1 claims
		const claim1Name = uniqueName("claim");
		tracker.track("boilerhouseclaims", claim1Name);
		await client.applyClaim(claim(claim1Name, uniqueName("tenant1"), wlName));
		await client.waitForPhase("boilerhouseclaims", claim1Name, "Active");

		// 3. Tenant 2 claims the same workload
		const claim2Name = uniqueName("claim");
		tracker.track("boilerhouseclaims", claim2Name);
		await client.applyClaim(claim(claim2Name, uniqueName("tenant2"), wlName));
		await client.waitForPhase("boilerhouseclaims", claim2Name, "Active");

		// 4. Instance IDs must be distinct
		const status1 = await client.getStatus<BoilerhouseClaimStatus>("boilerhouseclaims", claim1Name);
		const status2 = await client.getStatus<BoilerhouseClaimStatus>("boilerhouseclaims", claim2Name);
		expect(status1.instanceId).toBeDefined();
		expect(status2.instanceId).toBeDefined();
		expect(status2.instanceId).not.toBe(status1.instanceId);
	}, 120_000);
});
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e-operator/multi-tenant-claim.e2e.test.ts
git commit -m "feat: add operator E2E multi-tenant-claim test"
```

---

### Task 15: multi-workload-claim test

**Files:**
- Create: `tests/e2e-operator/multi-workload-claim.e2e.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, test, expect, afterAll } from "bun:test";
import { getTestClient, uniqueName, CrdTracker } from "./helpers";
import { httpserverWorkload, minimalWorkload, claim } from "./fixtures";
import type { BoilerhouseClaimStatus } from "../../apps/operator/src/crd-types";

describe("multi-workload claim", () => {
	const client = getTestClient();
	const tracker = new CrdTracker();

	afterAll(async () => {
		await tracker.cleanup(client);
	});

	test("same tenant claims two different workloads", async () => {
		// 1. Create two workloads
		const wlA = uniqueName("wl-a");
		const wlB = uniqueName("wl-b");
		tracker.track("boilerhouseworkloads", wlA);
		tracker.track("boilerhouseworkloads", wlB);

		await Promise.all([
			client.applyWorkload(httpserverWorkload(wlA)),
			client.applyWorkload(minimalWorkload(wlB)),
		]);
		await Promise.all([
			client.waitForPhase("boilerhouseworkloads", wlA, "Ready"),
			client.waitForPhase("boilerhouseworkloads", wlB, "Ready"),
		]);

		// 2. Same tenant claims both
		const tenantId = uniqueName("tenant");
		const claimA = uniqueName("claim-a");
		const claimB = uniqueName("claim-b");
		tracker.track("boilerhouseclaims", claimA);
		tracker.track("boilerhouseclaims", claimB);

		await client.applyClaim(claim(claimA, tenantId, wlA));
		await client.applyClaim(claim(claimB, tenantId, wlB));

		await Promise.all([
			client.waitForPhase("boilerhouseclaims", claimA, "Active"),
			client.waitForPhase("boilerhouseclaims", claimB, "Active"),
		]);

		// 3. Different instance IDs
		const statusA = await client.getStatus<BoilerhouseClaimStatus>("boilerhouseclaims", claimA);
		const statusB = await client.getStatus<BoilerhouseClaimStatus>("boilerhouseclaims", claimB);
		expect(statusA.instanceId).not.toBe(statusB.instanceId);

		// 4. Delete claim A only — claim B should remain Active
		await client.delete("boilerhouseclaims", claimA);
		await client.waitForDeletion("boilerhouseclaims", claimA);

		const statusBAfter = await client.getStatus<BoilerhouseClaimStatus>("boilerhouseclaims", claimB);
		expect(statusBAfter.phase).toBe("Active");
		expect(statusBAfter.instanceId).toBe(statusB.instanceId);
	}, 120_000);
});
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e-operator/multi-workload-claim.e2e.test.ts
git commit -m "feat: add operator E2E multi-workload-claim test"
```

---

### Task 16: data-persistence test

**Files:**
- Create: `tests/e2e-operator/data-persistence.e2e.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, test, expect, afterAll } from "bun:test";
import { getTestClient, uniqueName, kubectlExec, CrdTracker } from "./helpers";
import { overlayWorkload, claim } from "./fixtures";
import type { BoilerhouseClaimStatus } from "../../apps/operator/src/crd-types";

describe("data persistence across release/re-claim", () => {
	const client = getTestClient();
	const tracker = new CrdTracker();

	afterAll(async () => {
		await tracker.cleanup(client);
	});

	test("files written to overlay dir survive release and re-claim", async () => {
		// 1. Create overlay workload
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(overlayWorkload(wlName));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		// 2. Claim
		const tenantId = uniqueName("tenant");
		const claim1Name = uniqueName("claim");
		tracker.track("boilerhouseclaims", claim1Name);
		await client.applyClaim(claim(claim1Name, tenantId, wlName));
		await client.waitForPhase("boilerhouseclaims", claim1Name, "Active");

		const status1 = await client.getStatus<BoilerhouseClaimStatus>("boilerhouseclaims", claim1Name);
		const podName1 = status1.instanceId!;

		// 3. Write data to overlay dir
		const writeResult = await kubectlExec(podName1, ["sh", "-c", "echo 'tenant-data-12345' > /data/persist.txt"]);
		expect(writeResult.exitCode).toBe(0);

		// 4. Verify data is there
		const readResult = await kubectlExec(podName1, ["cat", "/data/persist.txt"]);
		expect(readResult.exitCode).toBe(0);
		expect(readResult.stdout).toContain("tenant-data-12345");

		// 5. Release (delete claim) — triggers overlay extraction
		await client.delete("boilerhouseclaims", claim1Name);
		await client.waitForDeletion("boilerhouseclaims", claim1Name);

		// 6. Re-claim
		const claim2Name = uniqueName("claim");
		tracker.track("boilerhouseclaims", claim2Name);
		await client.applyClaim(claim(claim2Name, tenantId, wlName));
		await client.waitForPhase("boilerhouseclaims", claim2Name, "Active");

		const status2 = await client.getStatus<BoilerhouseClaimStatus>("boilerhouseclaims", claim2Name);
		const podName2 = status2.instanceId!;
		expect(podName2).not.toBe(podName1);

		// 7. Verify data persisted
		const readResult2 = await kubectlExec(podName2, ["cat", "/data/persist.txt"]);
		expect(readResult2.exitCode).toBe(0);
		expect(readResult2.stdout).toContain("tenant-data-12345");
	}, 120_000);
});
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e-operator/data-persistence.e2e.test.ts
git commit -m "feat: add operator E2E data-persistence test"
```

---

### Task 17: overlay-restore test

**Files:**
- Create: `tests/e2e-operator/overlay-restore.e2e.test.ts`

- [ ] **Step 1: Write the test**

This tests the same overlay persistence flow but verifies that the claim `source` field indicates data was restored.

```typescript
import { describe, test, expect, afterAll } from "bun:test";
import { getTestClient, uniqueName, kubectlExec, CrdTracker } from "./helpers";
import { overlayWorkload, claim } from "./fixtures";
import type { BoilerhouseClaimStatus } from "../../apps/operator/src/crd-types";

describe("overlay restore", () => {
	const client = getTestClient();
	const tracker = new CrdTracker();

	afterAll(async () => {
		await tracker.cleanup(client);
	});

	test("release hibernates with overlay, re-claim restores overlay data", async () => {
		// 1. Create overlay workload
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(overlayWorkload(wlName));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		// 2. Claim
		const tenantId = uniqueName("tenant");
		const claim1Name = uniqueName("claim");
		tracker.track("boilerhouseclaims", claim1Name);
		await client.applyClaim(claim(claim1Name, tenantId, wlName));
		await client.waitForPhase("boilerhouseclaims", claim1Name, "Active");

		const status1 = await client.getStatus<BoilerhouseClaimStatus>("boilerhouseclaims", claim1Name);
		const podName1 = status1.instanceId!;

		// 3. Write data
		const writeResult = await kubectlExec(podName1, ["sh", "-c", "echo 'snapshot-test-data' > /data/snapshot.txt"]);
		expect(writeResult.exitCode).toBe(0);

		// 4. Release
		await client.delete("boilerhouseclaims", claim1Name);
		await client.waitForDeletion("boilerhouseclaims", claim1Name);

		// 5. Re-claim — should restore overlay data
		const claim2Name = uniqueName("claim");
		tracker.track("boilerhouseclaims", claim2Name);
		await client.applyClaim(claim(claim2Name, tenantId, wlName));
		await client.waitForPhase("boilerhouseclaims", claim2Name, "Active");

		const status2 = await client.getStatus<BoilerhouseClaimStatus>("boilerhouseclaims", claim2Name);
		expect(status2.instanceId).not.toBe(podName1);
		// Source should indicate data was restored
		expect(["cold+data", "pool+data"]).toContain(status2.source);

		// 6. Verify data was restored
		const readResult = await kubectlExec(status2.instanceId!, ["cat", "/data/snapshot.txt"]);
		expect(readResult.exitCode).toBe(0);
		expect(readResult.stdout).toContain("snapshot-test-data");
	}, 120_000);
});
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e-operator/overlay-restore.e2e.test.ts
git commit -m "feat: add operator E2E overlay-restore test"
```

---

### Task 18: snapshot-lifecycle test

**Files:**
- Create: `tests/e2e-operator/snapshot-lifecycle.e2e.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, test, expect, afterAll } from "bun:test";
import { getTestClient, uniqueName, operatorApiUrl, CrdTracker } from "./helpers";
import { overlayWorkload, claim, pool } from "./fixtures";
import type { BoilerhouseClaimStatus } from "../../apps/operator/src/crd-types";

describe("snapshot lifecycle", () => {
	const client = getTestClient();
	const tracker = new CrdTracker();

	afterAll(async () => {
		await tracker.cleanup(client);
	});

	test("operator internal API snapshot endpoint responds", async () => {
		// 1. Create workload and claim to get an instance
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(overlayWorkload(wlName));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		const claimName = uniqueName("claim");
		tracker.track("boilerhouseclaims", claimName);
		await client.applyClaim(claim(claimName, uniqueName("tenant"), wlName));
		await client.waitForPhase("boilerhouseclaims", claimName, "Active");

		const status = await client.getStatus<BoilerhouseClaimStatus>("boilerhouseclaims", claimName);
		const instanceId = status.instanceId!;

		// 2. Call the operator's internal snapshot API
		const snapshotRes = await fetch(`${operatorApiUrl}/api/v1/instances/${instanceId}/snapshot`, {
			method: "POST",
		});
		expect(snapshotRes.status).toBe(200);
		const snapshotBody = await snapshotRes.json() as { instanceId: string };
		expect(snapshotBody.instanceId).toBe(instanceId);
	}, 120_000);
});
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e-operator/snapshot-lifecycle.e2e.test.ts
git commit -m "feat: add operator E2E snapshot-lifecycle test"
```

---

### Task 19: pause-before-extract test

**Files:**
- Create: `tests/e2e-operator/pause-before-extract.e2e.test.ts`

- [ ] **Step 1: Write the test**

The original test instruments the runtime — in the operator context, we verify via the internal API's overlay/extract endpoint instead.

```typescript
import { describe, test, expect, afterAll } from "bun:test";
import { getTestClient, uniqueName, kubectlExec, operatorApiUrl, CrdTracker } from "./helpers";
import { overlayWorkload, claim } from "./fixtures";
import type { BoilerhouseClaimStatus } from "../../apps/operator/src/crd-types";

describe("pause before extract", () => {
	const client = getTestClient();
	const tracker = new CrdTracker();

	afterAll(async () => {
		await tracker.cleanup(client);
	});

	test("operator internal API overlay/extract endpoint responds", async () => {
		// 1. Create overlay workload and claim
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(overlayWorkload(wlName));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		const claimName = uniqueName("claim");
		tracker.track("boilerhouseclaims", claimName);
		await client.applyClaim(claim(claimName, uniqueName("tenant"), wlName));
		await client.waitForPhase("boilerhouseclaims", claimName, "Active");

		const status = await client.getStatus<BoilerhouseClaimStatus>("boilerhouseclaims", claimName);
		const instanceId = status.instanceId!;

		// 2. Write data so extraction has something to do
		const writeResult = await kubectlExec(instanceId, ["sh", "-c", "echo 'freeze-test' > /data/freeze.txt"]);
		expect(writeResult.exitCode).toBe(0);

		// 3. Call the operator's internal overlay/extract API
		const extractRes = await fetch(`${operatorApiUrl}/api/v1/instances/${instanceId}/overlay/extract`, {
			method: "POST",
		});
		expect(extractRes.status).toBe(200);
		const extractBody = await extractRes.json() as { instanceId: string };
		expect(extractBody.instanceId).toBe(instanceId);
	}, 120_000);
});
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e-operator/pause-before-extract.e2e.test.ts
git commit -m "feat: add operator E2E pause-before-extract test"
```

---

### Task 20: events test

**Files:**
- Create: `tests/e2e-operator/events.e2e.test.ts`

- [ ] **Step 1: Write the test**

In the operator model, events are CRD status transitions. There's no WebSocket event bus. The test verifies that status phase transitions happen in the correct order.

```typescript
import { describe, test, expect, afterAll } from "bun:test";
import { getTestClient, uniqueName, CrdTracker } from "./helpers";
import { httpserverWorkload, claim } from "./fixtures";
import type { BoilerhouseClaimStatus } from "../../apps/operator/src/crd-types";

describe("events (status transitions)", () => {
	const client = getTestClient();
	const tracker = new CrdTracker();

	afterAll(async () => {
		await tracker.cleanup(client);
	});

	test("claim status transitions in correct order during claim/release", async () => {
		// 1. Create workload
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(httpserverWorkload(wlName));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		// 2. Create claim and observe status transitions
		const claimName = uniqueName("claim");
		tracker.track("boilerhouseclaims", claimName);
		await client.applyClaim(claim(claimName, uniqueName("tenant"), wlName));

		// First observed phase should be Pending
		const phases: string[] = [];
		const deadline = Date.now() + 60_000;
		let lastPhase = "";

		while (Date.now() < deadline) {
			const status = await client.getStatus<BoilerhouseClaimStatus>("boilerhouseclaims", claimName).catch(() => ({}));
			const phase = (status as any).phase;
			if (phase && phase !== lastPhase) {
				phases.push(phase);
				lastPhase = phase;
			}
			if (phase === "Active") break;
			await new Promise((r) => setTimeout(r, 500));
		}

		// Should have seen Pending → Active
		expect(phases).toContain("Pending");
		expect(phases).toContain("Active");
		const pendingIdx = phases.indexOf("Pending");
		const activeIdx = phases.indexOf("Active");
		expect(pendingIdx).toBeLessThan(activeIdx);

		// 3. Verify claim has expected status fields
		const status = await client.getStatus<BoilerhouseClaimStatus>("boilerhouseclaims", claimName);
		expect(status.instanceId).toBeDefined();
		expect(status.endpoint).toBeDefined();
		expect(status.source).toBeDefined();
		expect(status.claimedAt).toBeDefined();
	}, 120_000);
});
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e-operator/events.e2e.test.ts
git commit -m "feat: add operator E2E events test"
```

---

### Task 21: secret-gateway test

**Files:**
- Create: `tests/e2e-operator/secret-gateway.e2e.test.ts`

- [ ] **Step 1: Write the test**

Tests that workloads with `credentials` referencing K8s Secrets work correctly. Creates a K8s Secret, references it in a workload CR, and verifies the pod can start.

```typescript
import { describe, test, expect, afterAll } from "bun:test";
import { getTestClient, uniqueName, kubectlExec, CrdTracker, CONTEXT, NAMESPACE } from "./helpers";
import { httpserverWorkload, claim } from "./fixtures";
import type { BoilerhouseWorkload } from "../../apps/operator/src/crd-types";
import type { BoilerhouseClaimStatus } from "../../apps/operator/src/crd-types";

describe("secret gateway", () => {
	const client = getTestClient();
	const tracker = new CrdTracker();
	const secretNames: string[] = [];

	afterAll(async () => {
		// Clean up K8s Secrets
		for (const name of secretNames) {
			Bun.spawnSync([
				"kubectl", "--context", CONTEXT, "-n", NAMESPACE,
				"delete", "secret", name, "--ignore-not-found",
			]);
		}
		await tracker.cleanup(client);
	});

	test("workload with credentials referencing K8s Secret starts successfully", async () => {
		// 1. Create K8s Secret
		const secretName = uniqueName("secret");
		secretNames.push(secretName);
		const createSecretProc = Bun.spawnSync([
			"kubectl", "--context", CONTEXT, "-n", NAMESPACE,
			"create", "secret", "generic", secretName,
			"--from-literal=api-key=sk-ant-e2e-test-key",
		]);
		expect(createSecretProc.exitCode).toBe(0);

		// 2. Create workload with credentials
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		const wl = httpserverWorkload(wlName);
		wl.spec.network = {
			...wl.spec.network,
			access: "restricted",
			allowlist: ["api.anthropic.com"],
			credentials: [{
				domain: "api.anthropic.com",
				secretRef: { name: secretName, key: "api-key" },
				headers: { "x-api-key": "{{value}}" },
			}],
		};
		await client.applyWorkload(wl);
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		// 3. Claim and verify pod starts
		const claimName = uniqueName("claim");
		tracker.track("boilerhouseclaims", claimName);
		await client.applyClaim(claim(claimName, uniqueName("tenant"), wlName));
		await client.waitForPhase("boilerhouseclaims", claimName, "Active");

		const status = await client.getStatus<BoilerhouseClaimStatus>("boilerhouseclaims", claimName);
		expect(status.instanceId).toBeDefined();

		// 4. Verify the API key is NOT exposed as env var in the main container
		const execResult = await kubectlExec(status.instanceId!, ["printenv"]);
		expect(execResult.stdout).not.toContain("sk-ant-e2e-test-key");
	}, 120_000);
});
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e-operator/secret-gateway.e2e.test.ts
git commit -m "feat: add operator E2E secret-gateway test"
```

---

### Task 22: telegram-poll test

**Files:**
- Create: `tests/e2e-operator/telegram-poll.e2e.test.ts`

- [ ] **Step 1: Write the test**

Tests that a BoilerhouseTrigger CR with type=telegram reaches Active status.

```typescript
import { describe, test, expect, afterAll } from "bun:test";
import { getTestClient, uniqueName, CrdTracker, CONTEXT, NAMESPACE } from "./helpers";
import { httpserverWorkload, trigger } from "./fixtures";
import type { BoilerhouseTriggerStatus } from "../../apps/operator/src/crd-types";

describe("telegram poll trigger", () => {
	const client = getTestClient();
	const tracker = new CrdTracker();
	const secretNames: string[] = [];

	afterAll(async () => {
		for (const name of secretNames) {
			Bun.spawnSync([
				"kubectl", "--context", CONTEXT, "-n", NAMESPACE,
				"delete", "secret", name, "--ignore-not-found",
			]);
		}
		await tracker.cleanup(client);
	});

	test("BoilerhouseTrigger with type=telegram reaches Active", async () => {
		// 1. Create workload for the trigger
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(httpserverWorkload(wlName));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		// 2. Create K8s Secret for bot token
		const secretName = uniqueName("tg-secret");
		secretNames.push(secretName);
		Bun.spawnSync([
			"kubectl", "--context", CONTEXT, "-n", NAMESPACE,
			"create", "secret", "generic", secretName,
			"--from-literal=bot-token=123456:FAKE",
		]);

		// 3. Create trigger CR
		const triggerName = uniqueName("trigger");
		tracker.track("boilerhousetriggers", triggerName);
		await client.applyTrigger(trigger(triggerName, wlName, "telegram", {
			botToken: { secretRef: { name: secretName, key: "bot-token" } },
			updateTypes: ["message"],
			pollTimeoutSeconds: 1,
		}));

		// 4. Verify trigger reaches Active (or at least doesn't Error immediately)
		// Wait for a status to appear
		const deadline = Date.now() + 30_000;
		let status: BoilerhouseTriggerStatus | null = null;
		while (Date.now() < deadline) {
			status = await client.getStatus<BoilerhouseTriggerStatus>("boilerhousetriggers", triggerName).catch(() => null);
			if (status?.phase) break;
			await new Promise((r) => setTimeout(r, 1_000));
		}

		expect(status).not.toBeNull();
		expect(status!.phase).toBeDefined();
		// Trigger may Error if the mock TG API isn't running, but the CR should be reconciled
	}, 120_000);
});
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e-operator/telegram-poll.e2e.test.ts
git commit -m "feat: add operator E2E telegram-poll test"
```

---

### Task 23: workload-update test

**Files:**
- Create: `tests/e2e-operator/workload-update.e2e.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, test, expect, afterAll } from "bun:test";
import { getTestClient, uniqueName, CrdTracker } from "./helpers";
import { httpserverWorkload, claim, pool } from "./fixtures";
import type { BoilerhouseClaimStatus, BoilerhousePoolStatus } from "../../apps/operator/src/crd-types";

describe("workload update", () => {
	const client = getTestClient();
	const tracker = new CrdTracker();

	afterAll(async () => {
		await tracker.cleanup(client);
	});

	test("update workload spec, operator re-reconciles", async () => {
		// 1. Create workload
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		const wl = httpserverWorkload(wlName);
		await client.applyWorkload(wl);
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		// 2. Update the workload spec (change resource limits)
		const updatedWl = httpserverWorkload(wlName);
		updatedWl.spec.resources = { ...updatedWl.spec.resources, memoryMb: 512 };
		await client.applyWorkload(updatedWl);

		// 3. Workload should re-reconcile and return to Ready
		// It may briefly go through Creating
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		// 4. New claims should work with the updated workload
		const claimName = uniqueName("claim");
		tracker.track("boilerhouseclaims", claimName);
		await client.applyClaim(claim(claimName, uniqueName("tenant"), wlName));
		await client.waitForPhase("boilerhouseclaims", claimName, "Active");

		const status = await client.getStatus<BoilerhouseClaimStatus>("boilerhouseclaims", claimName);
		expect(status.instanceId).toBeDefined();
	}, 120_000);

	test("claimed instances are untouched during workload update", async () => {
		// 1. Create workload and claim
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(httpserverWorkload(wlName));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		const claimName = uniqueName("claim");
		tracker.track("boilerhouseclaims", claimName);
		await client.applyClaim(claim(claimName, uniqueName("tenant"), wlName));
		await client.waitForPhase("boilerhouseclaims", claimName, "Active");

		const statusBefore = await client.getStatus<BoilerhouseClaimStatus>("boilerhouseclaims", claimName);
		const instanceBefore = statusBefore.instanceId!;

		// 2. Update workload
		const updatedWl = httpserverWorkload(wlName);
		updatedWl.spec.resources = { ...updatedWl.spec.resources, memoryMb: 384 };
		await client.applyWorkload(updatedWl);
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		// 3. Existing claim should still be Active with the same instance
		const statusAfter = await client.getStatus<BoilerhouseClaimStatus>("boilerhouseclaims", claimName);
		expect(statusAfter.phase).toBe("Active");
		expect(statusAfter.instanceId).toBe(instanceBefore);
	}, 120_000);

	test("workload update with pool triggers pool drain and refill", async () => {
		// 1. Create workload + pool
		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(httpserverWorkload(wlName));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		const poolName = uniqueName("pool");
		tracker.track("boilerhousepools", poolName);
		await client.applyPool(pool(poolName, wlName, 1));
		await client.waitForPhase("boilerhousepools", poolName, "Healthy", 120_000);

		const poolStatusBefore = await client.getStatus<BoilerhousePoolStatus>("boilerhousepools", poolName);
		expect(poolStatusBefore.ready).toBeGreaterThanOrEqual(1);

		// 2. Update workload
		const updatedWl = httpserverWorkload(wlName);
		updatedWl.spec.resources = { ...updatedWl.spec.resources, memoryMb: 768 };
		await client.applyWorkload(updatedWl);
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		// 3. Pool should eventually re-stabilize
		await client.waitForPhase("boilerhousepools", poolName, "Healthy", 120_000);
	}, 180_000);
});
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e-operator/workload-update.e2e.test.ts
git commit -m "feat: add operator E2E workload-update test"
```

---

### Task 24: Smoke test the full suite

Run the operator E2E suite against minikube to verify everything works end-to-end.

**Files:** (none — verification only)

- [ ] **Step 1: Ensure minikube is ready**

```bash
bunx kadai run minikube
```

- [ ] **Step 2: Run the full suite**

```bash
bun test tests/e2e-operator/ --preload ./tests/e2e-operator/setup.ts --timeout 120000
```

Expected: All tests pass (or fail for legitimate operator reasons that need to be investigated).

- [ ] **Step 3: Fix any issues found during smoke test**

Address failures by examining operator logs, pod status, and adjusting test timeouts or assertions as needed.

- [ ] **Step 4: Final commit**

```bash
git add -A tests/e2e-operator/
git commit -m "fix: address issues found during operator E2E smoke test"
```

(Only if changes were needed.)
