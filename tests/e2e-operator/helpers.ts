import { randomBytes } from "node:crypto";
import { KubernetesRuntimeError } from "@boilerhouse/k8s";
import type { KubeClientConfig } from "@boilerhouse/k8s";
import {
	API_GROUP,
	API_VERSION,
	type BoilerhouseWorkload,
	type BoilerhouseClaim,
	type BoilerhousePool,
	type BoilerhouseTrigger,
} from "../../apps/operator/src/crd-types";

// ── Constants ───────────────────────────────────────────────────────────────

export const NAMESPACE = "boilerhouse";
export const CONTEXT = "boilerhouse-test";
export const DEFAULT_TIMEOUT_MS = 120_000;
export const POLL_INTERVAL_MS = 1_000;

// ── CRD resource names (plural, lowercase) ──────────────────────────────────

export type CrdResource =
	| "boilerhouseworkloads"
	| "boilerhouseclaims"
	| "boilerhousepools"
	| "boilerhousetriggers";

// ── Operator API URL (set by setup.ts) ──────────────────────────────────────

export let operatorApiUrl = "http://localhost:19090";

export function setOperatorApiUrl(url: string) {
	operatorApiUrl = url;
}

// ── Unique name generator ───────────────────────────────────────────────────

export function uniqueName(prefix: string): string {
	const hex = randomBytes(4).toString("hex");
	return `test-${hex}-${prefix}`;
}

// ── Global test client singleton ────────────────────────────────────────────

let _testClient: KubeTestClient | null = null;

export function getTestClient(): KubeTestClient {
	if (!_testClient) throw new Error("KubeTestClient not initialized — is setup.ts loaded?");
	return _testClient;
}

export function setTestClient(client: KubeTestClient) {
	_testClient = client;
}

// ── CrdTracker ──────────────────────────────────────────────────────────────

interface TrackedCrd {
	resource: CrdResource;
	name: string;
}

const DELETION_ORDER: CrdResource[] = [
	"boilerhousetriggers",
	"boilerhouseclaims",
	"boilerhousepools",
	"boilerhouseworkloads",
];

export class CrdTracker {
	private tracked: TrackedCrd[] = [];

	track(resource: CrdResource, name: string) {
		this.tracked.push({ resource, name });
	}

	async cleanup(client: KubeTestClient) {
		// Group by resource
		const byResource = new Map<CrdResource, string[]>();
		for (const t of this.tracked) {
			const list = byResource.get(t.resource) ?? [];
			list.push(t.name);
			byResource.set(t.resource, list);
		}

		// Delete in dependency order
		for (const resource of DELETION_ORDER) {
			const names = byResource.get(resource);
			if (!names) continue;
			for (const name of names) {
				await client.delete(resource, name);
			}
		}

		// Wait for all deletions
		for (const resource of DELETION_ORDER) {
			const names = byResource.get(resource);
			if (!names) continue;
			for (const name of names) {
				try {
					await client.waitForDeletion(resource, name, 30_000);
				} catch {
					// best-effort cleanup
				}
			}
		}

		this.tracked = [];
	}
}

// ── KubeTestClient ──────────────────────────────────────────────────────────

export class KubeTestClient {
	private readonly apiUrl: string;
	private readonly token: string;
	private readonly tlsOptions: { rejectUnauthorized: boolean; ca?: string };

	constructor(config: KubeClientConfig) {
		this.apiUrl = config.apiUrl.replace(/\/$/, "");
		this.token = config.token;
		this.tlsOptions = config.caCert
			? { rejectUnauthorized: true, ca: config.caCert }
			: { rejectUnauthorized: false };
	}

	// ── CRD path builder ────────────────────────────────────────────────────

	private crdPath(resource: CrdResource, name?: string): string {
		const base = `/apis/${API_GROUP}/${API_VERSION}/namespaces/${NAMESPACE}/${resource}`;
		return name ? `${base}/${name}` : base;
	}

	// ── Core CRUD ───────────────────────────────────────────────────────────

	async apply<T extends { metadata: { name: string; namespace?: string; resourceVersion?: string } }>(
		resource: CrdResource,
		obj: T,
	): Promise<T> {
		try {
			return await this.request<T>("POST", this.crdPath(resource), obj);
		} catch (err) {
			if (err instanceof KubernetesRuntimeError && err.statusCode === 409) {
				// Already exists — get resourceVersion, then PUT
				const existing = await this.request<T>(
					"GET",
					this.crdPath(resource, obj.metadata.name),
				);
				obj.metadata.resourceVersion = existing.metadata.resourceVersion;
				return this.request<T>(
					"PUT",
					this.crdPath(resource, obj.metadata.name),
					obj,
				);
			}
			throw err;
		}
	}

	async applyWorkload(obj: BoilerhouseWorkload): Promise<BoilerhouseWorkload> {
		return this.apply("boilerhouseworkloads", obj);
	}

	async applyClaim(obj: BoilerhouseClaim): Promise<BoilerhouseClaim> {
		return this.apply("boilerhouseclaims", obj);
	}

	async applyPool(obj: BoilerhousePool): Promise<BoilerhousePool> {
		return this.apply("boilerhousepools", obj);
	}

	async applyTrigger(obj: BoilerhouseTrigger): Promise<BoilerhouseTrigger> {
		return this.apply("boilerhousetriggers", obj);
	}

	async delete(resource: CrdResource, name: string): Promise<void> {
		try {
			await this.request("DELETE", this.crdPath(resource, name));
		} catch (err) {
			if (err instanceof KubernetesRuntimeError && err.statusCode === 404) {
				return; // already gone
			}
			throw err;
		}
	}

	async deleteAll(tracked: TrackedCrd[]): Promise<void> {
		const byResource = new Map<CrdResource, string[]>();
		for (const t of tracked) {
			const list = byResource.get(t.resource) ?? [];
			list.push(t.name);
			byResource.set(t.resource, list);
		}

		for (const resource of DELETION_ORDER) {
			const names = byResource.get(resource);
			if (!names) continue;
			for (const name of names) {
				await this.delete(resource, name);
			}
		}

		for (const resource of DELETION_ORDER) {
			const names = byResource.get(resource);
			if (!names) continue;
			for (const name of names) {
				await this.waitForDeletion(resource, name, 30_000);
			}
		}
	}

	async get<T = unknown>(resource: CrdResource, name: string): Promise<T> {
		return this.request<T>("GET", this.crdPath(resource, name));
	}

	async getStatus(resource: CrdResource, name: string): Promise<Record<string, unknown> | undefined> {
		const obj = await this.request<{ status?: Record<string, unknown> }>(
			"GET",
			this.crdPath(resource, name),
		);
		return obj.status;
	}

	async waitForPhase(
		resource: CrdResource,
		name: string,
		phase: string,
		timeoutMs = DEFAULT_TIMEOUT_MS,
	): Promise<Record<string, unknown>> {
		const deadline = Date.now() + timeoutMs;

		while (Date.now() < deadline) {
			const status = await this.getStatus(resource, name);
			if (status?.phase === phase) return status;
			if (status?.phase === "Error") {
				throw new Error(
					`${resource}/${name} reached Error phase: ${status.detail ?? "unknown"}`,
				);
			}
			await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
		}

		const finalStatus = await this.getStatus(resource, name);
		throw new Error(
			`${resource}/${name} did not reach phase "${phase}" within ${timeoutMs}ms (current: ${finalStatus?.phase ?? "none"})`,
		);
	}

	async waitForDeletion(
		resource: CrdResource,
		name: string,
		timeoutMs = DEFAULT_TIMEOUT_MS,
	): Promise<void> {
		const deadline = Date.now() + timeoutMs;

		while (Date.now() < deadline) {
			try {
				await this.request("GET", this.crdPath(resource, name));
			} catch (err) {
				if (err instanceof KubernetesRuntimeError && err.statusCode === 404) {
					return;
				}
				throw err;
			}
			await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
		}

		throw new Error(`${resource}/${name} was not deleted within ${timeoutMs}ms`);
	}

	// ── HTTP plumbing ───────────────────────────────────────────────────────

	private async request<T>(
		method: string,
		path: string,
		body?: unknown,
		queryParams?: Record<string, string | number>,
	): Promise<T> {
		const url = this.buildUrl(path, queryParams);
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.token}`,
			Accept: "application/json",
		};
		const init: RequestInit = { method, headers };

		if (body !== undefined) {
			headers["Content-Type"] = "application/json";
			init.body = JSON.stringify(body);
		}

		(init as Record<string, unknown>).tls = this.tlsOptions;

		const res = await fetch(url, init);
		const text = await res.text();

		if (!res.ok) {
			let message = `K8s API ${method} ${path}: ${res.status}`;
			try {
				const errBody = JSON.parse(text) as { message?: string };
				if (errBody.message) message = errBody.message;
			} catch {
				if (text) message += ` - ${text.slice(0, 200)}`;
			}
			throw new KubernetesRuntimeError(message, res.status);
		}

		if (!text) return {} as T;
		return JSON.parse(text) as T;
	}

	private buildUrl(path: string, params?: Record<string, string | number>): string {
		const url = new URL(path, this.apiUrl);
		if (params) {
			for (const [k, v] of Object.entries(params)) {
				url.searchParams.set(k, String(v));
			}
		}
		return url.toString();
	}
}

// ── kubectl wrappers ────────────────────────────────────────────────────────

async function runKubectl(...args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["kubectl", "--context", CONTEXT, "-n", NAMESPACE, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});

	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	return { exitCode, stdout, stderr };
}

export async function kubectlExec(
	podName: string,
	command: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return runKubectl("exec", podName, "--", ...command);
}

export async function kubectlLogs(podName: string, tailLines?: number): Promise<string> {
	const args = ["logs", podName];
	if (tailLines !== undefined) args.push("--tail", String(tailLines));
	const result = await runKubectl(...args);
	return result.stdout;
}

export async function kubectlGetPodPhase(podName: string): Promise<string> {
	const result = await runKubectl("get", "pod", podName, "-o", "jsonpath={.status.phase}");
	return result.stdout;
}

export async function kubectlPodExists(podName: string): Promise<boolean> {
	const result = await runKubectl("get", "pod", podName, "--no-headers");
	return result.exitCode === 0;
}

export async function kubectlPortForward(
	podName: string,
	containerPort: number,
): Promise<{ localPort: number; stop: () => void }> {
	const proc = Bun.spawn(
		["kubectl", "--context", CONTEXT, "-n", NAMESPACE, "port-forward", podName, `:${containerPort}`],
		{ stdout: "pipe", stderr: "pipe" },
	);

	const reader = proc.stdout.getReader();
	const deadline = Date.now() + 15_000;
	let buffer = "";

	while (Date.now() < deadline) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += new TextDecoder().decode(value);

		const match = buffer.match(/Forwarding from 127\.0\.0\.1:(\d+)/);
		if (match) {
			reader.releaseLock();
			const localPort = Number(match[1]);

			// Wait for port to accept connections
			const portDeadline = Date.now() + 5_000;
			while (Date.now() < portDeadline) {
				try {
					const conn = await Bun.connect({ hostname: "127.0.0.1", port: localPort, socket: {
						data() {},
						open(socket) { socket.end(); },
						error() {},
						close() {},
					}});
					break;
				} catch {
					await new Promise((r) => setTimeout(r, 200));
				}
			}

			return {
				localPort,
				stop: () => proc.kill(),
			};
		}
	}

	proc.kill();
	throw new Error(`kubectl port-forward did not produce local port within 15s`);
}
