import { test, expect, beforeAll, afterAll } from "bun:test";
import { BoilerhouseClient } from "./client";

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
const requests: { method: string; url: string; body?: unknown }[] = [];

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const body = req.method !== "GET" ? await req.json().catch(() => null) : null;
			requests.push({ method: req.method, url: url.pathname, body });

			// Error case — check before general claim handler
			if (url.pathname === "/api/v1/tenants/bad/claim" && req.method === "POST") {
				return Response.json({ error: "no golden snapshot" }, { status: 503 });
			}

			// Claim tenant
			if (url.pathname.match(/\/api\/v1\/tenants\/[^/]+\/claim/) && req.method === "POST") {
				return Response.json({
					tenantId: "t-1",
					instanceId: "i-1",
					endpoint: { host: "10.0.0.1", port: 8080 },
					source: "warm",
					latencyMs: 42,
				});
			}

			// Release tenant
			if (url.pathname.match(/\/api\/v1\/tenants\/[^/]+\/release/) && req.method === "POST") {
				return Response.json({ ok: true });
			}

			// Get instance status
			if (url.pathname.match(/\/api\/v1\/instances\/[^/]+$/) && req.method === "GET") {
				return Response.json({
					instanceId: "i-1",
					status: "active",
				});
			}

			return new Response("Not Found", { status: 404 });
		},
	});
	baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
	server.stop(true);
});

test("claimTenant sends correct request and returns result", async () => {
	requests.length = 0;
	const client = new BoilerhouseClient(baseUrl);
	const result = await client.claimTenant("t-1", "my-workload");

	expect(result.tenantId).toBe("t-1");
	expect(result.instanceId).toBe("i-1");
	expect(result.endpoint.host).toBe("10.0.0.1");
	expect(result.endpoint.port).toBe(8080);
	expect(result.source).toBe("warm");

	const req = requests.find(r => r.url.includes("/claim"));
	expect(req).toBeDefined();
	expect(req!.method).toBe("POST");
	expect(req!.body).toEqual({ workload: "my-workload" });
});

test("releaseTenant sends correct request", async () => {
	requests.length = 0;
	const client = new BoilerhouseClient(baseUrl);
	await client.releaseTenant("t-1");

	const req = requests.find(r => r.url.includes("/release"));
	expect(req).toBeDefined();
	expect(req!.method).toBe("POST");
	expect(req!.url).toBe("/api/v1/tenants/t-1/release");
});

test("getInstanceStatus sends correct request", async () => {
	requests.length = 0;
	const client = new BoilerhouseClient(baseUrl);
	const result = await client.getInstanceStatus("i-1");

	expect(result.instanceId).toBe("i-1");
	expect(result.status).toBe("active");
});

test("claimTenant throws on error response", async () => {
	const client = new BoilerhouseClient(baseUrl);
	await expect(client.claimTenant("bad", "w")).rejects.toThrow();
});
