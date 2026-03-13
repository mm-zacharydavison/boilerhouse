import { test, expect, beforeAll, afterAll } from "bun:test";
import { createWebhookRoutes } from "./webhook";
import { Dispatcher } from "../dispatcher";
import { BoilerhouseClient } from "../client";
import type { TriggerDefinition, WebhookConfig } from "../config";

let apiServer: ReturnType<typeof Bun.serve>;
let agentServer: ReturnType<typeof Bun.serve>;
let apiUrl: string;

beforeAll(() => {
	agentServer = Bun.serve({
		port: 0,
		async fetch(req) {
			const body = await req.json();
			return Response.json({ reply: "ok", received: body });
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

function makeTrigger(config: WebhookConfig): TriggerDefinition & { config: WebhookConfig } {
	return {
		name: "test-hook",
		type: "webhook",
		tenant: { static: "t-1" },
		workload: "w-1",
		config,
	};
}

test("payload passthrough with static tenant", async () => {
	const client = new BoilerhouseClient(apiUrl);
	const dispatcher = new Dispatcher(client, { waitForReady: false });
	const routes = createWebhookRoutes(
		[makeTrigger({ path: "/hooks/test" })],
		dispatcher,
	);

	const handler = routes["/hooks/test"]!;
	const res = await handler(
		new Request("http://localhost/hooks/test", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "hello" }),
		}),
	);

	expect(res.status).toBe(200);
	const body = await res.json() as Record<string, unknown>;
	expect(body.reply).toBe("ok");
});

test("tenant resolved from body field", async () => {
	const client = new BoilerhouseClient(apiUrl);
	const dispatcher = new Dispatcher(client, { waitForReady: false });
	const trigger: TriggerDefinition & { config: WebhookConfig } = {
		name: "dynamic-hook",
		type: "webhook",
		tenant: { fromField: "tenantId", prefix: "wh-" },
		workload: "w-1",
		config: { path: "/hooks/dynamic" },
	};
	const routes = createWebhookRoutes([trigger], dispatcher);

	const handler = routes["/hooks/dynamic"]!;
	const res = await handler(
		new Request("http://localhost/hooks/dynamic", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ tenantId: "user-42", data: "test" }),
		}),
	);

	expect(res.status).toBe(200);
});

test("tenant resolution failure returns 400", async () => {
	const client = new BoilerhouseClient(apiUrl);
	const dispatcher = new Dispatcher(client, { waitForReady: false });
	const trigger: TriggerDefinition & { config: WebhookConfig } = {
		name: "missing-field-hook",
		type: "webhook",
		tenant: { fromField: "userId" },
		workload: "w-1",
		config: { path: "/hooks/missing" },
	};
	const routes = createWebhookRoutes([trigger], dispatcher);

	const handler = routes["/hooks/missing"]!;
	const res = await handler(
		new Request("http://localhost/hooks/missing", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ data: "no userId field" }),
		}),
	);

	expect(res.status).toBe(400);
	const body = await res.json() as Record<string, unknown>;
	expect(body.error).toContain("userId");
});

test("HMAC validation - valid signature accepted", async () => {
	const secret = "test-secret-key";
	const payload = JSON.stringify({ data: "test" });

	// Compute valid HMAC
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
	const signature = `sha256=${Buffer.from(sig).toString("hex")}`;

	const client = new BoilerhouseClient(apiUrl);
	const dispatcher = new Dispatcher(client, { waitForReady: false });
	const routes = createWebhookRoutes(
		[makeTrigger({ path: "/hooks/secure", secret })],
		dispatcher,
	);

	const handler = routes["/hooks/secure"]!;
	const res = await handler(
		new Request("http://localhost/hooks/secure", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Signature-256": signature,
			},
			body: payload,
		}),
	);

	expect(res.status).toBe(200);
});

test("HMAC validation - invalid signature rejected", async () => {
	const client = new BoilerhouseClient(apiUrl);
	const dispatcher = new Dispatcher(client, { waitForReady: false });
	const routes = createWebhookRoutes(
		[makeTrigger({ path: "/hooks/secure", secret: "my-secret" })],
		dispatcher,
	);

	const handler = routes["/hooks/secure"]!;
	const res = await handler(
		new Request("http://localhost/hooks/secure", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Signature-256": "sha256=invalid",
			},
			body: JSON.stringify({ data: "test" }),
		}),
	);

	expect(res.status).toBe(401);
});

test("HMAC validation - missing signature rejected", async () => {
	const client = new BoilerhouseClient(apiUrl);
	const dispatcher = new Dispatcher(client, { waitForReady: false });
	const routes = createWebhookRoutes(
		[makeTrigger({ path: "/hooks/secure", secret: "my-secret" })],
		dispatcher,
	);

	const handler = routes["/hooks/secure"]!;
	const res = await handler(
		new Request("http://localhost/hooks/secure", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ data: "test" }),
		}),
	);

	expect(res.status).toBe(401);
});

test("multiple webhook triggers get separate routes", async () => {
	const client = new BoilerhouseClient(apiUrl);
	const dispatcher = new Dispatcher(client, { waitForReady: false });
	const routes = createWebhookRoutes(
		[
			makeTrigger({ path: "/hooks/a" }),
			{ ...makeTrigger({ path: "/hooks/b" }), name: "hook-b" },
		],
		dispatcher,
	);

	expect(routes["/hooks/a"]).toBeDefined();
	expect(routes["/hooks/b"]).toBeDefined();
});
