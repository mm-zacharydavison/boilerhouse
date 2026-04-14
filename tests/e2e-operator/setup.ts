import { beforeAll, afterAll } from "bun:test";
import { Subprocess } from "bun";
import {
	KubeTestClient,
	setTestClient,
	setOperatorApiUrl,
	NAMESPACE,
	CONTEXT,
} from "./helpers";

const OPERATOR_PORT = 19090;
const HEALTHZ_TIMEOUT_MS = 30_000;
const MINIKUBE_PROFILE = "boilerhouse-test";

let operatorProc: Subprocess | null = null;

async function run(cmd: string[]): Promise<string> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const stdout = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`Command failed: ${cmd.join(" ")}\n${stderr}`);
	}
	return stdout.trim();
}

beforeAll(async () => {
	// 1. Verify minikube cluster is running
	try {
		await run(["minikube", "status", "-p", MINIKUBE_PROFILE, "--format", "{{.Host}}"]);
	} catch {
		throw new Error(
			`Minikube profile "${MINIKUBE_PROFILE}" is not running. ` +
				`Start it with: bunx kadai run minikube`,
		);
	}

	// 2. Apply CRDs (idempotent)
	const crdsDir = new URL("../../apps/operator/crds/", import.meta.url).pathname;
	await run(["kubectl", "--context", CONTEXT, "apply", "-f", crdsDir]);

	// 2b. Clean up stale test resources from previous runs.
	// Unique naming prevents interference, but crashed runs can leave orphans.
	for (const crd of ["boilerhousetriggers", "boilerhouseclaims", "boilerhousepools", "boilerhouseworkloads"]) {
		try {
			await run([
				"kubectl", "--context", CONTEXT, "-n", NAMESPACE,
				"delete", `${crd}.boilerhouse.dev`, "--all", "--timeout=15s",
			]);
		} catch {
			// CRD may not have any resources yet — ignore
		}
	}

	// 3. Apply RBAC (idempotent) — operator SA + test SA
	const rbacPath = new URL("../../apps/operator/deploy/rbac.yaml", import.meta.url).pathname;
	await run(["kubectl", "--context", CONTEXT, "apply", "-f", rbacPath]);

	// Create test SA with full CRD CRUD permissions (tests create/delete CRDs like a user would)
	const testRbac = `
apiVersion: v1
kind: ServiceAccount
metadata:
  name: boilerhouse-test
  namespace: ${NAMESPACE}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: boilerhouse-test
  namespace: ${NAMESPACE}
rules:
  - apiGroups: ["boilerhouse.dev"]
    resources: [boilerhouseworkloads, boilerhousepools, boilerhouseclaims, boilerhousetriggers]
    verbs: ["*"]
  - apiGroups: ["boilerhouse.dev"]
    resources: [boilerhouseworkloads/status, boilerhousepools/status, boilerhouseclaims/status, boilerhousetriggers/status]
    verbs: ["get"]
  - apiGroups: [""]
    resources: [pods, pods/exec, pods/log, services, secrets]
    verbs: ["*"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: boilerhouse-test
  namespace: ${NAMESPACE}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: boilerhouse-test
subjects:
  - kind: ServiceAccount
    name: boilerhouse-test
    namespace: ${NAMESPACE}
`;
	const rbacProc = Bun.spawn(["kubectl", "--context", CONTEXT, "apply", "-f", "-"], {
		stdin: new TextEncoder().encode(testRbac),
		stdout: "pipe",
		stderr: "pipe",
	});
	await rbacProc.exited;

	// 4. Get minikube auth
	const minikubeIp = await run(["minikube", "ip", "-p", MINIKUBE_PROFILE]);

	// Operator token — for the operator process
	const operatorToken = await run([
		"kubectl", "--context", CONTEXT,
		"create", "token", "boilerhouse-operator",
		"-n", NAMESPACE,
	]);

	// Test client token — for CRD CRUD operations
	const testToken = await run([
		"kubectl", "--context", CONTEXT,
		"create", "token", "boilerhouse-test",
		"-n", NAMESPACE,
	]);
	const caCert = await run([
		"minikube",
		"-p",
		MINIKUBE_PROFILE,
		"ssh",
		"cat /var/lib/minikube/certs/ca.crt",
	]);

	const k8sApiUrl = `https://${minikubeIp}:8443`;

	// 5. Spawn operator
	operatorProc = Bun.spawn(["bun", "run", "apps/operator/src/main.ts"], {
		cwd: new URL("../../", import.meta.url).pathname,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			K8S_API_URL: k8sApiUrl,
			K8S_TOKEN: operatorToken,
			K8S_CA_CERT: caCert,
			K8S_NAMESPACE: NAMESPACE,
			K8S_CONTEXT: CONTEXT,
			K8S_MINIKUBE_PROFILE: MINIKUBE_PROFILE,
			INTERNAL_API_PORT: String(OPERATOR_PORT),
			DB_PATH: ":memory:",
			STORAGE_PATH: "/tmp/boilerhouse-e2e-operator",
		},
	});

	// 6. Poll healthz until 200
	const healthUrl = `http://localhost:${OPERATOR_PORT}/healthz`;
	const deadline = Date.now() + HEALTHZ_TIMEOUT_MS;

	while (Date.now() < deadline) {
		try {
			const res = await fetch(healthUrl);
			if (res.ok) break;
		} catch {
			// not up yet
		}
		await new Promise((r) => setTimeout(r, 500));
	}

	// Verify it actually came up
	try {
		const res = await fetch(healthUrl);
		if (!res.ok) throw new Error(`healthz returned ${res.status}`);
	} catch (err) {
		operatorProc.kill();
		throw new Error(`Operator did not become healthy within ${HEALTHZ_TIMEOUT_MS}ms: ${err}`);
	}

	// 7. Create and set test client
	const client = new KubeTestClient({ apiUrl: k8sApiUrl, token: testToken, caCert });
	setTestClient(client);
	setOperatorApiUrl(`http://localhost:${OPERATOR_PORT}`);
});

afterAll(async () => {
	if (operatorProc) {
		operatorProc.kill();
		await operatorProc.exited;
		operatorProc = null;
	}
});
