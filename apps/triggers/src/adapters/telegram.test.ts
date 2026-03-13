import { test, expect, beforeAll, afterAll } from "bun:test";
import { createTelegramRoutes } from "./telegram";
import { Dispatcher } from "../dispatcher";
import { BoilerhouseClient } from "../client";
import type { TriggerDefinition, TelegramConfig } from "../config";

let apiServer: ReturnType<typeof Bun.serve>;
let agentServer: ReturnType<typeof Bun.serve>;
let apiUrl: string;

beforeAll(() => {
	agentServer = Bun.serve({
		port: 0,
		async fetch(req) {
			const body = await req.json();
			return Response.json({ text: "bot reply", received: body });
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

function makeTrigger(overrides?: Partial<TelegramConfig>): TriggerDefinition & { config: TelegramConfig } {
	return {
		name: "tg-test",
		type: "telegram",
		tenant: { fromField: "chatId", prefix: "tg-" },
		workload: "w-1",
		config: {
			botToken: "123456:ABC-test-token",
			secretToken: "my-secret",
			updateTypes: ["message"],
			...overrides,
		},
	};
}

test("valid message update dispatches with derived tenant", async () => {
	const client = new BoilerhouseClient(apiUrl);
	const dispatcher = new Dispatcher(client, { waitForReady: false });
	const routes = createTelegramRoutes([makeTrigger()], dispatcher);
	const handler = routes["/telegram/tg-test"]!;

	const res = await handler(
		new Request("http://localhost/telegram/tg-test", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Telegram-Bot-Api-Secret-Token": "my-secret",
			},
			body: JSON.stringify({
				update_id: 1,
				message: {
					message_id: 1,
					text: "hello bot",
					chat: { id: 12345 },
					from: { id: 1, first_name: "Test" },
				},
			}),
		}),
	);

	expect(res.status).toBe(200);
});

test("invalid secret token is rejected", async () => {
	const client = new BoilerhouseClient(apiUrl);
	const dispatcher = new Dispatcher(client, { waitForReady: false });
	const routes = createTelegramRoutes([makeTrigger()], dispatcher);
	const handler = routes["/telegram/tg-test"]!;

	const res = await handler(
		new Request("http://localhost/telegram/tg-test", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Telegram-Bot-Api-Secret-Token": "wrong-secret",
			},
			body: JSON.stringify({
				update_id: 1,
				message: { text: "hello", chat: { id: 1 } },
			}),
		}),
	);

	expect(res.status).toBe(401);
});

test("missing secret token is rejected when configured", async () => {
	const client = new BoilerhouseClient(apiUrl);
	const dispatcher = new Dispatcher(client, { waitForReady: false });
	const routes = createTelegramRoutes([makeTrigger()], dispatcher);
	const handler = routes["/telegram/tg-test"]!;

	const res = await handler(
		new Request("http://localhost/telegram/tg-test", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				update_id: 1,
				message: { text: "hello", chat: { id: 1 } },
			}),
		}),
	);

	expect(res.status).toBe(401);
});

test("no secret token config allows all requests", async () => {
	const client = new BoilerhouseClient(apiUrl);
	const dispatcher = new Dispatcher(client, { waitForReady: false });
	const routes = createTelegramRoutes(
		[makeTrigger({ secretToken: undefined })],
		dispatcher,
	);
	const handler = routes["/telegram/tg-test"]!;

	const res = await handler(
		new Request("http://localhost/telegram/tg-test", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				update_id: 1,
				message: { text: "hello", chat: { id: 1 }, from: { id: 99 } },
			}),
		}),
	);

	expect(res.status).toBe(200);
});

test("non-matching update type is ignored", async () => {
	const client = new BoilerhouseClient(apiUrl);
	const dispatcher = new Dispatcher(client, { waitForReady: false });
	const routes = createTelegramRoutes(
		[makeTrigger({ updateTypes: ["callback_query"] })],
		dispatcher,
	);
	const handler = routes["/telegram/tg-test"]!;

	const res = await handler(
		new Request("http://localhost/telegram/tg-test", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Telegram-Bot-Api-Secret-Token": "my-secret",
			},
			body: JSON.stringify({
				update_id: 1,
				message: { text: "hello", chat: { id: 1 } },
			}),
		}),
	);

	// Message update doesn't match callback_query filter
	expect(res.status).toBe(200);
});

test("each trigger gets its own route", () => {
	const client = new BoilerhouseClient(apiUrl);
	const dispatcher = new Dispatcher(client, { waitForReady: false });
	const routes = createTelegramRoutes(
		[
			makeTrigger(),
			{ ...makeTrigger(), name: "tg-other" },
		],
		dispatcher,
	);

	expect(routes["/telegram/tg-test"]).toBeDefined();
	expect(routes["/telegram/tg-other"]).toBeDefined();
});
