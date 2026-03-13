import type { BoilerhouseClient } from "./client";

/**
 * Polls the container endpoint until it accepts a connection and
 * returns an HTTP response (any status code).
 * Retries every `intervalMs` up to `timeoutMs`.
 */
export async function waitForReady(
	url: string,
	{ intervalMs = 500, timeoutMs = 15_000 } = {},
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url, {
				method: "GET",
				signal: AbortSignal.timeout(2_000),
			});
			// Drain the body so the connection is released
			await res.text().catch(() => {});
			return;
		} catch {
			await new Promise((r) => setTimeout(r, intervalMs));
		}
	}
	throw new DispatchError(
		`Container not ready after ${timeoutMs}ms at ${url}`,
		504,
	);
}

export interface TriggerEvent {
	/** Which trigger definition fired. */
	triggerName: string;
	/** Tenant to claim. */
	tenantId: string;
	/** Workload to run. */
	workload: string;
	/** Payload to forward to the agent container. */
	payload: unknown;
	/** Optional: where to send the response (adapter handles this). */
	respond?: (response: unknown) => Promise<void>;
}

export interface DispatchResult {
	/** Response from the agent container. */
	agentResponse: unknown;
	/** Instance ID that handled the request. */
	instanceId: string;
}

export interface DispatcherOptions {
	/**
	 * Whether to poll the container endpoint for readiness before forwarding.
	 * @default true
	 */
	waitForReady?: boolean;
}

export class Dispatcher {
	private shouldWaitForReady: boolean;

	constructor(
		private client: BoilerhouseClient,
		options?: DispatcherOptions,
	) {
		this.shouldWaitForReady = options?.waitForReady ?? true;
	}

	async dispatch(event: TriggerEvent): Promise<DispatchResult> {
		// 1. Claim the tenant
		let claim;
		try {
			claim = await this.client.claimTenant(event.tenantId, event.workload);
		} catch (err) {
			// Retry once on transient failure
			try {
				claim = await this.client.claimTenant(event.tenantId, event.workload);
			} catch (retryErr) {
				throw new DispatchError(
					`Failed to claim tenant ${event.tenantId}: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
					502,
				);
			}
		}

		// 2. Wait for the container to be ready (skip if already running)
		const agentUrl = `http://${claim.endpoint.host}:${claim.endpoint.port}/`;
		if (this.shouldWaitForReady && claim.source !== "existing") {
			await waitForReady(agentUrl);
		}

		// 3. Forward payload to the agent endpoint
		let agentRes: Response;
		try {
			agentRes = await fetch(agentUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(event.payload),
			});
		} catch {
			throw new DispatchError(
				`Agent endpoint unreachable at ${agentUrl}`,
				504,
			);
		}

		// 4. Parse agent response — read as text first to avoid "Body already used"
		const rawBody = await agentRes.text();
		let agentResponse: unknown;
		try {
			agentResponse = JSON.parse(rawBody);
		} catch {
			agentResponse = rawBody;
		}

		if (!agentRes.ok) {
			throw new DispatchError(
				`Agent returned error: HTTP ${agentRes.status}`,
				agentRes.status,
				agentResponse,
			);
		}

		// 5. Call respond callback if provided
		if (event.respond) {
			await event.respond(agentResponse);
		}

		return { agentResponse, instanceId: claim.instanceId };
	}
}

export class DispatchError extends Error {
	constructor(
		message: string,
		public readonly statusCode: number,
		public readonly body?: unknown,
	) {
		super(message);
		this.name = "DispatchError";
	}
}
