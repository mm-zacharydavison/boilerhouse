import { test, expect, beforeAll, afterAll } from "bun:test";
import { Dispatcher, DispatchError } from "./dispatcher";
import { BoilerhouseClient } from "./client";

let apiServer: ReturnType<typeof Bun.serve>;
let agentServer: ReturnType<typeof Bun.serve>;
let apiUrl: string;
let agentHost: string;
let agentPort = 0;

let claimCount = 0;
let agentPayloads: unknown[] = [];
let apiShouldFail = false;
let agentShouldFail = false;

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

	apiServer = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);

			if (url.pathname.match(/\/api\/v1\/tenants\/[^/]+\/claim/) && req.method === "POST") {
				claimCount++;
				if (apiShouldFail) {
					return Response.json({ error: "no golden snapshot" }, { status: 503 });
				}
				return Response.json({
					tenantId: "t-1",
					instanceId: "i-1",
					endpoint: { host: agentHost, port: agentPort },
					source: "warm",
					latencyMs: 10,
				});
			}

			return new Response("Not Found", { status: 404 });
		},
	});
	apiUrl = `http://localhost:${apiServer.port}`;
});

afterAll(() => {
	apiServer.stop(true);
	agentServer.stop(true);
});

test("happy path: claim succeeds, payload forwarded, response returned", async () => {
	claimCount = 0;
	agentPayloads = [];
	apiShouldFail = false;
	agentShouldFail = false;

	const client = new BoilerhouseClient(apiUrl);
	const dispatcher = new Dispatcher(client, { waitForReady: false });

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
});

test("calls respond callback with agent response", async () => {
	apiShouldFail = false;
	agentShouldFail = false;

	const client = new BoilerhouseClient(apiUrl);
	const dispatcher = new Dispatcher(client, { waitForReady: false });

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
	apiShouldFail = true;
	agentShouldFail = false;
	claimCount = 0;

	const client = new BoilerhouseClient(apiUrl);
	const dispatcher = new Dispatcher(client, { waitForReady: false });

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
});

test("agent endpoint unreachable returns 504", async () => {
	apiShouldFail = false;
	agentShouldFail = false;

	// Stop the agent server to simulate unreachable
	agentServer.stop(true);

	const client = new BoilerhouseClient(apiUrl);
	const dispatcher = new Dispatcher(client, { waitForReady: false });

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
	apiShouldFail = false;
	agentShouldFail = true;

	const client = new BoilerhouseClient(apiUrl);
	const dispatcher = new Dispatcher(client, { waitForReady: false });

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
