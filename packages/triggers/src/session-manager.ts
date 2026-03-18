/**
 * Manages persistent WebSocket sessions between the trigger layer
 * and container endpoints, keyed by tenant ID.
 *
 * Sequential mode: one message at a time per session.
 * Messages arriving while a previous one is in-flight are queued.
 */

interface PendingMessage {
	payload: unknown;
	resolve: (response: unknown) => void;
	reject: (err: Error) => void;
}

interface Session {
	ws: WebSocket;
	wsPath: string;
	endpoint: { host: string; port: number };
	/** Currently waiting for a response. */
	inflight: PendingMessage | null;
	/** Queued messages waiting to be sent. */
	queue: PendingMessage[];
}

export class SessionManager {
	private sessions: Map<string, Session> = new Map();
	/** In-flight session creation promises to prevent duplicate connections. */
	private connecting: Map<string, Promise<Session>> = new Map();
	/** Timeout for waiting for a WebSocket response. */
	private responseTimeoutMs: number;

	constructor(options?: {
		/** @default 30000 */
		responseTimeoutMs?: number;
	}) {
		this.responseTimeoutMs = options?.responseTimeoutMs ?? 30_000;
	}

	/**
	 * Send a message over a persistent WebSocket session for the given tenant.
	 * Creates the session if it doesn't exist or if the previous one closed.
	 */
	async send(
		tenantId: string,
		endpoint: { host: string; port: number },
		wsPath: string,
		payload: unknown,
	): Promise<unknown> {
		let session = this.sessions.get(tenantId);

		// If we have a session but endpoint/path changed or WS is closed, remove it
		if (session) {
			const endpointChanged =
				session.endpoint.host !== endpoint.host ||
				session.endpoint.port !== endpoint.port ||
				session.wsPath !== wsPath;

			if (endpointChanged || session.ws.readyState === WebSocket.CLOSED || session.ws.readyState === WebSocket.CLOSING) {
				this.removeSession(tenantId);
				session = undefined;
			}
		}

		// Session not yet open (still CONNECTING) or doesn't exist — wait for creation
		if (!session || session.ws.readyState !== WebSocket.OPEN) {
			let pending = this.connecting.get(tenantId);
			if (!pending) {
				pending = this.createSession(tenantId, endpoint, wsPath);
				this.connecting.set(tenantId, pending);
			}
			try {
				session = await pending;
			} finally {
				this.connecting.delete(tenantId);
			}
		}

		return this.enqueue(session, payload);
	}

	/** Remove a session and close the WebSocket. */
	remove(tenantId: string): void {
		this.removeSession(tenantId);
	}

	/** Close all sessions. */
	closeAll(): void {
		for (const [tenantId] of this.sessions) {
			this.removeSession(tenantId);
		}
	}

	/** Number of active sessions. */
	get size(): number {
		return this.sessions.size;
	}

	private async createSession(
		tenantId: string,
		endpoint: { host: string; port: number },
		wsPath: string,
	): Promise<Session> {
		const url = `ws://${endpoint.host}:${endpoint.port}${wsPath}`;
		const ws = new WebSocket(url);

		const session: Session = {
			ws,
			wsPath,
			endpoint,
			inflight: null,
			queue: [],
		};

		this.sessions.set(tenantId, session);

		// Wait for the WebSocket to open
		const connectResult = await new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
			ws.onopen = () => {
				ws.onerror = null;
				resolve({ ok: true });
			};
			ws.onerror = (e) => {
				ws.onopen = null;
				this.sessions.delete(tenantId);
				resolve({
					ok: false,
					error: e instanceof ErrorEvent ? e.message : "connection error",
				});
			};
		});

		if (!connectResult.ok) {
			throw new SessionError(
				`WebSocket connection failed to ${url}: ${connectResult.error}`,
			);
		}

		// Handle incoming messages — resolve the inflight promise
		ws.addEventListener("message", (event) => {
			if (!session.inflight) return;

			const { resolve } = session.inflight;
			session.inflight = null;

			let response: unknown;
			try {
				response = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
			} catch {
				response = event.data;
			}

			resolve(response);

			// Process next queued message
			this.processQueue(session);
		});

		// Handle close — reject inflight, reject all queued, remove session
		ws.addEventListener("close", () => {
			if (session.inflight) {
				session.inflight.reject(new SessionError("WebSocket closed while waiting for response"));
				session.inflight = null;
			}
			for (const pending of session.queue) {
				pending.reject(new SessionError("WebSocket closed while message was queued"));
			}
			session.queue = [];
			this.sessions.delete(tenantId);
		});

		// Handle errors — close triggers cleanup above
		ws.addEventListener("error", () => {
			ws.close();
		});

		return session;
	}

	private enqueue(session: Session, payload: unknown): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const pending: PendingMessage = { payload, resolve, reject };

			if (session.inflight) {
				session.queue.push(pending);
			} else {
				this.sendPending(session, pending);
			}
		});
	}

	private sendPending(session: Session, pending: PendingMessage): void {
		session.inflight = pending;

		if (session.ws.readyState !== WebSocket.OPEN) {
			session.inflight = null;
			pending.reject(new SessionError(
				`WebSocket not open (readyState=${session.ws.readyState})`,
			));
			return;
		}

		try {
			session.ws.send(JSON.stringify(pending.payload));
		} catch (err) {
			session.inflight = null;
			pending.reject(
				err instanceof Error ? err : new SessionError(String(err)),
			);
			return;
		}

		// Timeout for response
		const timer = setTimeout(() => {
			if (session.inflight === pending) {
				session.inflight = null;
				pending.reject(new SessionError(
					`WebSocket response timed out after ${this.responseTimeoutMs}ms`,
				));
				// Process next in queue even on timeout
				this.processQueue(session);
			}
		}, this.responseTimeoutMs);

		// Clear timeout when resolved/rejected
		const origResolve = pending.resolve;
		const origReject = pending.reject;
		pending.resolve = (val) => {
			clearTimeout(timer);
			origResolve(val);
		};
		pending.reject = (err) => {
			clearTimeout(timer);
			origReject(err);
		};
	}

	private processQueue(session: Session): void {
		if (session.queue.length === 0) return;
		const next = session.queue.shift()!;
		this.sendPending(session, next);
	}

	private removeSession(tenantId: string): void {
		const session = this.sessions.get(tenantId);
		if (!session) return;

		this.sessions.delete(tenantId);

		if (session.inflight) {
			session.inflight.reject(new SessionError("Session removed"));
			session.inflight = null;
		}
		for (const pending of session.queue) {
			pending.reject(new SessionError("Session removed"));
		}
		session.queue = [];

		if (session.ws.readyState === WebSocket.OPEN || session.ws.readyState === WebSocket.CONNECTING) {
			session.ws.close();
		}
	}
}

export class SessionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionError";
	}
}
