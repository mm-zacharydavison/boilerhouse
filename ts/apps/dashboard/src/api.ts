const BASE = "/api/v1";

async function get<T>(path: string): Promise<T> {
	const res = await fetch(`${BASE}${path}`);
	if (!res.ok) {
		const body = await res.json().catch(() => null);
		throw new Error(
			(body as { error?: string } | null)?.error ??
				`HTTP ${res.status}: ${res.statusText}`,
		);
	}
	return res.json() as Promise<T>;
}

async function post<T>(path: string): Promise<T> {
	const res = await fetch(`${BASE}${path}`, { method: "POST" });
	if (!res.ok) {
		const body = await res.json().catch(() => null);
		throw new Error(
			(body as { error?: string } | null)?.error ??
				`HTTP ${res.status}: ${res.statusText}`,
		);
	}
	return res.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const resBody = await res.json().catch(() => null);
		throw new Error(
			(resBody as { error?: string } | null)?.error ??
				`HTTP ${res.status}: ${res.statusText}`,
		);
	}
	return res.json() as Promise<T>;
}

async function del<T>(path: string): Promise<T> {
	const res = await fetch(`${BASE}${path}`, { method: "DELETE" });
	if (!res.ok) {
		const body = await res.json().catch(() => null);
		throw new Error(
			(body as { error?: string } | null)?.error ??
				`HTTP ${res.status}: ${res.statusText}`,
		);
	}
	return res.json() as Promise<T>;
}

// --- Types matching Go API CRD-shaped responses ---

export interface StatsResponse {
	instances: { total: number; byPhase: Record<string, number> };
	claims: { total: number; byPhase: Record<string, number> };
}

// Workload -- matches Go API workloadResponse
export interface WorkloadResponse {
	name: string;
	spec: {
		version: string;
		image: { ref: string };
		resources: { vcpus: number; memoryMb: number; diskGb: number };
		network?: {
			access?: string;
			expose?: Array<{ guest?: number }>;
			allowlist?: string[];
			websocket?: string;
		};
		idle?: { timeoutSeconds?: number; action?: string; watchDirs?: string[] };
		health?: {
			intervalSeconds?: number;
			unhealthyThreshold?: number;
			httpGet?: { path?: string; port?: number };
			exec?: { command?: string[] };
		};
		entrypoint?: { cmd?: string; args?: string[]; workdir?: string };
		filesystem?: { overlayDirs?: string[]; encryptOverlays?: boolean };
	};
	status: {
		phase?: string;
		detail?: string;
		observedGeneration?: number;
	};
	createdAt: string;
}

// Instance -- mapped from Pod by Go API
export interface InstanceResponse {
	name: string;
	phase: string;
	tenantId?: string;
	workloadRef?: string;
	ip?: string;
	labels?: Record<string, string>;
	createdAt: string;
	lastActivity?: string;
	claimedAt?: string;
}

// Claim response from POST /tenants/:id/claim
export interface ClaimResponse {
	tenantId: string;
	phase: string;
	instanceId?: string;
	endpoint?: { host: string; port: number };
	source?: string;
	claimedAt?: string;
	detail?: string;
}

// Trigger -- matches Go API triggerResponse
export interface TriggerResponse {
	name: string;
	spec: {
		type: string;
		workloadRef: string;
		tenant?: { static?: string; from?: string; prefix?: string };
		driver?: string;
		driverOptions?: unknown;
		config?: unknown;
		guards?: Array<{ type?: string; config?: unknown }>;
	};
	status: {
		phase?: string;
		detail?: string;
	};
	createdAt: string;
}

// Snapshot entry from the snapshots PVC
export interface SnapshotEntry {
	tenantId: string;
	workloadRef: string;
	path: string;
}

// Debug resources
export interface DebugResourceEntry {
	name: string;
	phase: string;
	age: string;
	summary: Record<string, unknown>;
	raw: unknown;
}

export interface DebugResourcesResponse {
	workloads: DebugResourceEntry[];
	pools: DebugResourceEntry[];
	claims: DebugResourceEntry[];
	triggers: DebugResourceEntry[];
	pods: DebugResourceEntry[];
	persistentVolumeClaims: DebugResourceEntry[];
	services: DebugResourceEntry[];
	networkPolicies: DebugResourceEntry[];
}

// --- API methods ---

export const api = {
	fetchStats: () => get<StatsResponse>("/stats"),

	fetchWorkloads: () => get<WorkloadResponse[]>("/workloads"),

	fetchWorkload: (name: string) => get<WorkloadResponse>(`/workloads/${encodeURIComponent(name)}`),

	fetchInstances: () => get<InstanceResponse[]>("/instances"),

	fetchInstance: (id: string) => get<InstanceResponse>(`/instances/${encodeURIComponent(id)}`),

	fetchInstanceLogs: async (id: string, tail = 200): Promise<string | null> => {
		try {
			const res = await fetch(`${BASE}/instances/${encodeURIComponent(id)}/logs?tail=${tail}`);
			if (!res.ok) return null;
			return res.text();
		} catch {
			return null;
		}
	},

	destroyInstance: (id: string) =>
		post<{ status: string; instance: string }>(
			`/instances/${encodeURIComponent(id)}/destroy`,
		),

	claimWorkload: (tenantId: string, workloadName: string) =>
		postJson<ClaimResponse>(`/tenants/${encodeURIComponent(tenantId)}/claim`, {
			workload: workloadName,
		}),

	releaseWorkload: (tenantId: string, workloadName: string) =>
		postJson<{ status: string }>(`/tenants/${encodeURIComponent(tenantId)}/release`, {
			workload: workloadName,
		}),

	// Snapshots
	fetchSnapshots: () => get<SnapshotEntry[]>("/snapshots"),
	fetchWorkloadSnapshots: (name: string) =>
		get<SnapshotEntry[]>(`/workloads/${encodeURIComponent(name)}/snapshots`),

	// Triggers
	fetchTriggers: () => get<TriggerResponse[]>("/triggers"),

	// Debug resources
	fetchDebugResources: () => get<DebugResourcesResponse>("/debug/resources"),

	deleteTrigger: (id: string) =>
		del<{ status: string }>(`/triggers/${encodeURIComponent(id)}`),
};
