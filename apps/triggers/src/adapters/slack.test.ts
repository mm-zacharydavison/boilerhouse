import { test, expect, beforeAll, afterAll } from "bun:test";
import { createSlackRoutes } from "./slack";
import { Dispatcher } from "../dispatcher";
import { BoilerhouseClient } from "../client";
import type { TriggerDefinition, SlackConfig } from "../config";

let apiServer: ReturnType<typeof Bun.serve>;
let agentServer: ReturnType<typeof Bun.serve>;
let apiUrl: string;
const signingSecret = "slack-signing-secret";

beforeAll(() => {
	agentServer = Bun.serve({
		port: 0,
		async fetch(req) {
			const body = await req.json();
			return Response.json({ text: "agent reply", received: body });
		},
	});

	apiServer = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname.match(/\/api\/v1\/tenants\/[^/]+\/claim/) && req.method === "POST") {
				return Response.json({
					tenantId: "t-1",
					instanceId: "i-1",
					endpoint: { host: "localhost", port: agentServer.port },
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

function makeTrigger(): TriggerDefinition & { config: SlackConfig } {
	return {
		name: "slack-test",
		type: "slack",
		tenant: { fromField: "user", prefix: "slack-" },
		workload: "w-1",
		config: {
			signingSecret,
			eventTypes: ["app_mention", "message"],
			botToken: "xoxb-test-token",
		},
	};
}

async function signRequest(body: string, timestamp: string): Promise<string> {
	const baseString = `v0:${timestamp}:${body}`;
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(signingSecret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(baseString));
	return `v0=${Buffer.from(sig).toString("hex")}`;
}

test("URL verification challenge response", async () => {
	const client = new BoilerhouseClient(apiUrl);
	const dispatcher = new Dispatcher(client, { waitForReady: false });
	const routes = createSlackRoutes([makeTrigger()], dispatcher);
	const handler = routes["/slack/events"]!;

	const body = JSON.stringify({
		type: "url_verification",
		challenge: "test-challenge-123",
	});

	const res = await handler(
		new Request("http://localhost/slack/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
		}),
	);

	expect(res.status).toBe(200);
	const json = await res.json() as Record<string, unknown>;
	expect(json.challenge).toBe("test-challenge-123");
});

test("event callback with valid signature dispatches with derived tenant", async () => {
	const client = new BoilerhouseClient(apiUrl);
	const dispatcher = new Dispatcher(client, { waitForReady: false });
	const routes = createSlackRoutes([makeTrigger()], dispatcher);
	const handler = routes["/slack/events"]!;

	const timestamp = Math.floor(Date.now() / 1000).toString();
	const body = JSON.stringify({
		type: "event_callback",
		event: {
			type: "app_mention",
			text: "hello bot",
			channel: "C123",
			user: "U456",
		},
	});
	const signature = await signRequest(body, timestamp);

	const res = await handler(
		new Request("http://localhost/slack/events", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Slack-Request-Timestamp": timestamp,
				"X-Slack-Signature": signature,
			},
			body,
		}),
	);

	expect(res.status).toBe(200);
});

test("event callback with invalid signature is rejected", async () => {
	const client = new BoilerhouseClient(apiUrl);
	const dispatcher = new Dispatcher(client, { waitForReady: false });
	const routes = createSlackRoutes([makeTrigger()], dispatcher);
	const handler = routes["/slack/events"]!;

	const body = JSON.stringify({
		type: "event_callback",
		event: { type: "app_mention", text: "hello", channel: "C123", user: "U456" },
	});

	const res = await handler(
		new Request("http://localhost/slack/events", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Slack-Request-Timestamp": "12345",
				"X-Slack-Signature": "v0=invalid",
			},
			body,
		}),
	);

	expect(res.status).toBe(401);
});

test("event callback with missing signature headers is rejected", async () => {
	const client = new BoilerhouseClient(apiUrl);
	const dispatcher = new Dispatcher(client, { waitForReady: false });
	const routes = createSlackRoutes([makeTrigger()], dispatcher);
	const handler = routes["/slack/events"]!;

	const body = JSON.stringify({
		type: "event_callback",
		event: { type: "app_mention", text: "hello", channel: "C123", user: "U456" },
	});

	const res = await handler(
		new Request("http://localhost/slack/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
		}),
	);

	expect(res.status).toBe(401);
});

test("non-matching event type returns 200 (ignored)", async () => {
	const client = new BoilerhouseClient(apiUrl);
	const dispatcher = new Dispatcher(client, { waitForReady: false });
	const routes = createSlackRoutes([makeTrigger()], dispatcher);
	const handler = routes["/slack/events"]!;

	const body = JSON.stringify({
		type: "event_callback",
		event: { type: "reaction_added", channel: "C123" },
	});

	const res = await handler(
		new Request("http://localhost/slack/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
		}),
	);

	expect(res.status).toBe(200);
});

test("empty triggers returns no routes", () => {
	const client = new BoilerhouseClient(apiUrl);
	const dispatcher = new Dispatcher(client, { waitForReady: false });
	const routes = createSlackRoutes([], dispatcher);
	expect(Object.keys(routes)).toHaveLength(0);
});
