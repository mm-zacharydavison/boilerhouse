// Typed fetch wrapper for the boilerhouse API

export interface ClaimResult {
	tenantId: string;
	instanceId: string;
	/** @example { host: "10.0.0.1", port: 8080 } */
	endpoint: { host: string; port: number };
	/** @example "warm" */
	source: string;
	latencyMs: number;
}

export interface InstanceStatus {
	instanceId: string;
	status: string;
}

export class BoilerhouseClient {
	constructor(private baseUrl: string) {}

	async claimTenant(tenantId: string, workload: string): Promise<ClaimResult> {
		const res = await fetch(
			`${this.baseUrl}/api/v1/tenants/${encodeURIComponent(tenantId)}/claim`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ workload }),
			},
		);
		if (!res.ok) {
			const body = await res.json().catch(() => null) as { error?: string } | null;
			throw new Error(
				body?.error ?? `Claim failed: HTTP ${res.status}`,
			);
		}
		return res.json() as Promise<ClaimResult>;
	}

	async releaseTenant(tenantId: string): Promise<void> {
		const res = await fetch(
			`${this.baseUrl}/api/v1/tenants/${encodeURIComponent(tenantId)}/release`,
			{ method: "POST" },
		);
		if (!res.ok) {
			const body = await res.json().catch(() => null) as { error?: string } | null;
			throw new Error(
				body?.error ?? `Release failed: HTTP ${res.status}`,
			);
		}
	}

	async getInstanceStatus(instanceId: string): Promise<InstanceStatus> {
		const res = await fetch(
			`${this.baseUrl}/api/v1/instances/${encodeURIComponent(instanceId)}`,
		);
		if (!res.ok) {
			const body = await res.json().catch(() => null) as { error?: string } | null;
			throw new Error(
				body?.error ?? `Get instance failed: HTTP ${res.status}`,
			);
		}
		return res.json() as Promise<InstanceStatus>;
	}
}
