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

	// 3. Apply RBAC (idempotent)
	const rbacPath = new URL("../../apps/operator/deploy/rbac.yaml", import.meta.url).pathname;
	await run(["kubectl", "--context", CONTEXT, "apply", "-f", rbacPath]);

	// 4. Get minikube auth
	const minikubeIp = await run(["minikube", "ip", "-p", MINIKUBE_PROFILE]);
	const token = await run([
		"kubectl",
		"--context",
		CONTEXT,
		"create",
		"token",
		"boilerhouse-operator",
		"-n",
		NAMESPACE,
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
			K8S_TOKEN: token,
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
	const client = new KubeTestClient({ apiUrl: k8sApiUrl, token, caCert });
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
