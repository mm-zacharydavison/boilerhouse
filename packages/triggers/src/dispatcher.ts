import type { SessionManager } from "./session-manager";

/** Claim result returned by the claim function. */
export interface ClaimResult {
	tenantId: string;
	instanceId: string;
	endpoint: { host: string; ports: number[] } | null;
	source: string;
	latencyMs: number;
	/** WebSocket path on the container, if the workload declares one. */
	websocket?: string;
}

/** Dependencies injected into the Dispatcher. */
export interface DispatcherDeps {
	/**
	 * Claim a tenant for a workload by name.
	 * The implementation should resolve the workload name → ID,
	 * call TenantManager.claim(), and return a ClaimResult.
	 */
	claim(tenantId: string, workloadName: string): Promise<ClaimResult>;

	/** Log an activity event. Fire-and-forget — must not throw. */
	logActivity(entry: {
		event: string;
		tenantId?: string;
		instanceId?: string;
		workloadId?: string;
		metadata?: Record<string, unknown>;
	}): void;
}

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
	/** SessionManager for persistent WebSocket connections. */
	sessionManager?: SessionManager;
}

export class Dispatcher {
	private shouldWaitForReady: boolean;
	private sessionManager: SessionManager | null;

	constructor(
		private deps: DispatcherDeps,
		options?: DispatcherOptions,
	) {
		this.shouldWaitForReady = options?.waitForReady ?? true;
		this.sessionManager = options?.sessionManager ?? null;
	}

	async dispatch(event: TriggerEvent): Promise<DispatchResult> {
		// Log trigger invocation
		this.deps.logActivity({
			event: "trigger.invoked",
			tenantId: event.tenantId,
			metadata: { trigger: event.triggerName, workload: event.workload },
		});

		// 1. Claim the tenant
		let claim: ClaimResult;
		try {
			claim = await this.deps.claim(event.tenantId, event.workload);
		} catch (err) {
			// Retry once on transient failure
			try {
				claim = await this.deps.claim(event.tenantId, event.workload);
			} catch (retryErr) {
				const error = new DispatchError(
					`Failed to claim tenant ${event.tenantId}: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
					502,
				);
				this.deps.logActivity({
					event: "trigger.error",
					tenantId: event.tenantId,
					metadata: { trigger: event.triggerName, phase: "claim", reason: error.message },
				});
				throw error;
			}
		}

		if (!claim.endpoint || claim.endpoint.ports.length === 0) {
			const error = new DispatchError(
				`Container has no endpoint for tenant ${event.tenantId}`,
				502,
			);
			this.deps.logActivity({
				event: "trigger.error",
				tenantId: event.tenantId,
				instanceId: claim.instanceId,
				metadata: { trigger: event.triggerName, phase: "endpoint", reason: error.message },
			});
			throw error;
		}

		const port = claim.endpoint.ports[0]!;

		// 2. Wait for the container to be ready (skip if already running)
		const agentUrl = `http://${claim.endpoint.host}:${port}/`;
		if (this.shouldWaitForReady && claim.source !== "existing") {
			try {
				await waitForReady(agentUrl);
			} catch (err) {
				this.deps.logActivity({
					event: "trigger.error",
					tenantId: event.tenantId,
					instanceId: claim.instanceId,
					metadata: { trigger: event.triggerName, phase: "readiness", reason: err instanceof Error ? err.message : String(err) },
				});
				throw err;
			}
		}

		let agentResponse: unknown;

		// 3. Branch: WebSocket or HTTP POST
		if (claim.websocket && this.sessionManager) {
			// Persistent WebSocket session
			try {
				agentResponse = await this.sessionManager.send(
					event.tenantId,
					{ host: claim.endpoint.host, port },
					claim.websocket,
					event.payload,
				);
			} catch (err) {
				const error = new DispatchError(
					`WebSocket dispatch failed for tenant ${event.tenantId}: ${err instanceof Error ? err.message : String(err)}`,
					504,
				);
				this.deps.logActivity({
					event: "trigger.error",
					tenantId: event.tenantId,
					instanceId: claim.instanceId,
					metadata: { trigger: event.triggerName, phase: "dispatch", reason: error.message },
				});
				throw error;
			}
		} else {
			// Stateless HTTP POST
			let agentRes: Response;
			try {
				agentRes = await fetch(agentUrl, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(event.payload),
				});
			} catch {
				const error = new DispatchError(
					`Agent endpoint unreachable at ${agentUrl}`,
					504,
				);
				this.deps.logActivity({
					event: "trigger.error",
					tenantId: event.tenantId,
					instanceId: claim.instanceId,
					metadata: { trigger: event.triggerName, phase: "dispatch", reason: error.message },
				});
				throw error;
			}

			// Parse agent response — read as text first to avoid "Body already used"
			const rawBody = await agentRes.text();
			try {
				agentResponse = JSON.parse(rawBody);
			} catch {
				agentResponse = rawBody;
			}

			if (!agentRes.ok) {
				const error = new DispatchError(
					`Agent returned error: HTTP ${agentRes.status}`,
					agentRes.status,
					agentResponse,
				);
				this.deps.logActivity({
					event: "trigger.error",
					tenantId: event.tenantId,
					instanceId: claim.instanceId,
					metadata: { trigger: event.triggerName, phase: "dispatch", reason: error.message, status: agentRes.status },
				});
				throw error;
			}
		}

		// 4. Call respond callback if provided
		if (event.respond) {
			await event.respond(agentResponse);
		}

		// Log successful dispatch
		this.deps.logActivity({
			event: "trigger.dispatched",
			tenantId: event.tenantId,
			instanceId: claim.instanceId,
			metadata: { trigger: event.triggerName, source: claim.source },
		});

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
