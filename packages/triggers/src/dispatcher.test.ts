import { test, expect, beforeAll, afterAll } from "bun:test";
import { Dispatcher, DispatchError } from "./dispatcher";
import type { DispatcherDeps } from "./dispatcher";
import { SessionManager } from "./session-manager";

let agentServer: ReturnType<typeof Bun.serve>;
let agentHost: string;
let agentPort = 0;

let claimCount = 0;
let agentPayloads: unknown[] = [];
let claimShouldFail = false;
let agentShouldFail = false;
let activityEvents: Array<{ event: string; [k: string]: unknown }> = [];

function createTestDeps(overrides?: Partial<DispatcherDeps>): DispatcherDeps {
	return {
		async claim(tenantId) {
			claimCount++;
			if (claimShouldFail) {
				throw new Error("no golden snapshot");
			}
			return {
				tenantId,
				instanceId: "i-1",
				endpoint: { host: agentHost, ports: [agentPort] },
				source: "warm",
				latencyMs: 10,
			};
		},
		logActivity(entry) {
			activityEvents.push(entry);
		},
		...overrides,
	};
}

beforeAll(() => {
	agentServer = Bun.serve({
		port: 0,
		async fetch(req) {
			if (agentShouldFail) {
				return Response.json({ error: "agent error" }, { status: 500 });
			}
			const body = await req.json();
			agentPayloads.push(body);
			return Response.json({ reply: "hello from agent", received: body });
		},
	});
	agentPort = agentServer.port!;
	agentHost = "localhost";
});

afterAll(() => {
	agentServer.stop(true);
});

test("happy path: claim succeeds, payload forwarded, response returned", async () => {
	claimCount = 0;
	agentPayloads = [];
	claimShouldFail = false;
	agentShouldFail = false;
	activityEvents = [];

	const deps = createTestDeps();
	const dispatcher = new Dispatcher(deps, { waitForReady: false });

	const result = await dispatcher.dispatch({
		triggerName: "test-trigger",
		tenantId: "t-1",
		workload: "my-workload",
		payload: { message: "hello" },
	});

	expect(claimCount).toBe(1);
	expect(agentPayloads).toHaveLength(1);
	expect(agentPayloads[0]).toEqual({ message: "hello" });
	expect(result.instanceId).toBe("i-1");
	expect((result.agentResponse as Record<string, unknown>).reply).toBe("hello from agent");

	// Verify activity events logged
	const invoked = activityEvents.find((e) => e.event === "trigger.invoked");
	const dispatched = activityEvents.find((e) => e.event === "trigger.dispatched");
	expect(invoked).toBeDefined();
	expect(dispatched).toBeDefined();
});

test("calls respond callback with agent response", async () => {
	claimShouldFail = false;
	agentShouldFail = false;

	const deps = createTestDeps();
	const dispatcher = new Dispatcher(deps, { waitForReady: false });

	let respondCalledWith: unknown;
	await dispatcher.dispatch({
		triggerName: "test-trigger",
		tenantId: "t-1",
		workload: "w",
		payload: {},
		respond: async (response) => {
			respondCalledWith = response;
		},
	});

	expect(respondCalledWith).toBeDefined();
	expect((respondCalledWith as Record<string, unknown>).reply).toBe("hello from agent");
});

test("claim failure returns 502 after retry", async () => {
	claimShouldFail = true;
	agentShouldFail = false;
	claimCount = 0;
	activityEvents = [];

	const deps = createTestDeps();
	const dispatcher = new Dispatcher(deps, { waitForReady: false });

	try {
		await dispatcher.dispatch({
			triggerName: "test-trigger",
			tenantId: "t-1",
			workload: "w",
			payload: {},
		});
		expect(true).toBe(false); // should not reach
	} catch (err) {
		expect(err).toBeInstanceOf(DispatchError);
		expect((err as DispatchError).statusCode).toBe(502);
		expect(claimCount).toBe(2); // initial + retry
	}

	const errorEvent = activityEvents.find((e) => e.event === "trigger.error");
	expect(errorEvent).toBeDefined();
});

test("agent endpoint unreachable returns 504", async () => {
	claimShouldFail = false;
	agentShouldFail = false;

	// Stop the agent server to simulate unreachable
	agentServer.stop(true);

	const deps = createTestDeps();
	const dispatcher = new Dispatcher(deps, { waitForReady: false });

	try {
		await dispatcher.dispatch({
			triggerName: "test-trigger",
			tenantId: "t-1",
			workload: "w",
			payload: {},
		});
		expect(true).toBe(false);
	} catch (err) {
		expect(err).toBeInstanceOf(DispatchError);
		expect((err as DispatchError).statusCode).toBe(504);
	}

	// Restart agent server for remaining tests
	agentServer = Bun.serve({
		port: agentPort,
		async fetch(req) {
			if (agentShouldFail) {
				return Response.json({ error: "agent error" }, { status: 500 });
			}
			const body = await req.json();
			agentPayloads.push(body);
			return Response.json({ reply: "hello from agent", received: body });
		},
	});
});

test("agent error is passed through", async () => {
	claimShouldFail = false;
	agentShouldFail = true;

	const deps = createTestDeps();
	const dispatcher = new Dispatcher(deps, { waitForReady: false });

	try {
		await dispatcher.dispatch({
			triggerName: "test-trigger",
			tenantId: "t-1",
			workload: "w",
			payload: {},
		});
		expect(true).toBe(false);
	} catch (err) {
		expect(err).toBeInstanceOf(DispatchError);
		expect((err as DispatchError).statusCode).toBe(500);
		expect((err as DispatchError).body).toEqual({ error: "agent error" });
	}
});

test("no endpoint throws 502", async () => {
	const deps = createTestDeps({
		async claim(tenantId) {
			return {
				tenantId,
				instanceId: "i-noep",
				endpoint: null,
				source: "warm",
				latencyMs: 10,
			};
		},
	});

	const dispatcher = new Dispatcher(deps, { waitForReady: false });

	try {
		await dispatcher.dispatch({
			triggerName: "test-trigger",
			tenantId: "t-1",
			workload: "w",
			payload: {},
		});
		expect(true).toBe(false);
	} catch (err) {
		expect(err).toBeInstanceOf(DispatchError);
		expect((err as DispatchError).statusCode).toBe(502);
	}
});

// ── WebSocket dispatch tests ────────────────────────────────────────────────

test("websocket: dispatches via SessionManager when claim includes websocket", async () => {
	// WS-capable agent server
	const wsAgentServer = Bun.serve({
		port: 0,
		fetch(req, server) {
			const url = new URL(req.url);
			if (url.pathname === "/ws") {
				server.upgrade(req);
				return undefined as unknown as Response;
			}
			return new Response("ok");
		},
		websocket: {
			message(ws, message) {
				const parsed = JSON.parse(String(message));
				ws.send(JSON.stringify({ echo: parsed.text, via: "websocket" }));
			},
		},
	});
	const wsAgentPort = wsAgentServer.port!;

	const deps = createTestDeps({
		async claim(tenantId) {
			return {
				tenantId,
				instanceId: "i-ws",
				endpoint: { host: "localhost", ports: [wsAgentPort] },
				source: "warm",
				latencyMs: 5,
				websocket: "/ws",
			};
		},
	});

	const sessionManager = new SessionManager();
	const dispatcher = new Dispatcher(deps, {
		waitForReady: false,
		sessionManager,
	});

	try {
		const result = await dispatcher.dispatch({
			triggerName: "ws-trigger",
			tenantId: "t-ws",
			workload: "ws-workload",
			payload: { text: "hello ws" },
		});

		expect(result.instanceId).toBe("i-ws");
		expect((result.agentResponse as Record<string, unknown>).echo).toBe("hello ws");
		expect((result.agentResponse as Record<string, unknown>).via).toBe("websocket");

		// Second message reuses the same session
		const result2 = await dispatcher.dispatch({
			triggerName: "ws-trigger",
			tenantId: "t-ws",
			workload: "ws-workload",
			payload: { text: "second" },
		});
		expect((result2.agentResponse as Record<string, unknown>).echo).toBe("second");
	} finally {
		sessionManager.closeAll();
		wsAgentServer.stop(true);
	}
});

test("websocket: falls back to HTTP POST when no sessionManager", async () => {
	// Agent server that handles HTTP POST
	const fallbackAgent = Bun.serve({
		port: 0,
		async fetch(req) {
			const body = await req.json();
			return Response.json({ reply: "via http", received: body });
		},
	});

	const deps = createTestDeps({
		async claim(tenantId) {
			return {
				tenantId,
				instanceId: "i-fb",
				endpoint: { host: "localhost", ports: [fallbackAgent.port!] },
				source: "warm",
				latencyMs: 5,
				websocket: "/ws",
			};
		},
	});

	// No sessionManager — should fall back to HTTP POST
	const dispatcher = new Dispatcher(deps, { waitForReady: false });

	try {
		const result = await dispatcher.dispatch({
			triggerName: "fb-trigger",
			tenantId: "t-fb",
			workload: "fb-workload",
			payload: { text: "fallback" },
		});

		expect(result.instanceId).toBe("i-fb");
		expect((result.agentResponse as Record<string, unknown>).reply).toBe("via http");
	} finally {
		fallbackAgent.stop(true);
	}
});

test("websocket: respond callback works with WebSocket dispatch", async () => {
	const wsAgent2 = Bun.serve({
		port: 0,
		fetch(req, server) {
			if (new URL(req.url).pathname === "/ws") {
				server.upgrade(req);
				return undefined as unknown as Response;
			}
			return new Response("ok");
		},
		websocket: {
			message(ws) {
				ws.send(JSON.stringify({ text: "ws response" }));
			},
		},
	});

	const deps = createTestDeps({
		async claim(tenantId) {
			return {
				tenantId,
				instanceId: "i-cb",
				endpoint: { host: "localhost", ports: [wsAgent2.port!] },
				source: "warm",
				latencyMs: 5,
				websocket: "/ws",
			};
		},
	});

	const sessionManager = new SessionManager();
	const dispatcher = new Dispatcher(deps, {
		waitForReady: false,
		sessionManager,
	});

	let respondCalledWith: unknown;
	try {
		await dispatcher.dispatch({
			triggerName: "cb-trigger",
			tenantId: "t-cb",
			workload: "cb-workload",
			payload: { text: "trigger" },
			respond: async (response) => {
				respondCalledWith = response;
			},
		});

		expect(respondCalledWith).toBeDefined();
		expect((respondCalledWith as Record<string, unknown>).text).toBe("ws response");
	} finally {
		sessionManager.closeAll();
		wsAgent2.stop(true);
	}
});
