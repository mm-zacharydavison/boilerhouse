import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ForwardProxy } from "./proxy";
import type { InstanceRoute } from "./proxy";
import { connect, type Socket } from "node:net";

let upstream: ReturnType<typeof Bun.serve>;
let proxy: ForwardProxy;
let proxyPort: number;
let upstreamPort: number;

/**
 * Opens a raw TCP connection to the proxy and sends data.
 * Returns the full response as a string.
 */
function rawRequest(
	port: number,
	data: string,
	options?: { timeout?: number },
): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		const timeout = options?.timeout ?? 2000;
		const sock: Socket = connect({ host: "127.0.0.1", port }, () => {
			sock.write(data);
		});
		sock.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		sock.on("end", () => resolve(Buffer.concat(chunks).toString()));
		sock.on("error", reject);
		setTimeout(() => {
			sock.end();
			resolve(Buffer.concat(chunks).toString());
		}, timeout);
	});
}

beforeAll(async () => {
	// Mock upstream HTTP server that echoes headers
	upstream = Bun.serve({
		port: 0,
		fetch(req) {
			const headers: Record<string, string> = {};
			req.headers.forEach((v, k) => {
				headers[k] = v;
			});
			return new Response(
				JSON.stringify({
					path: new URL(req.url).pathname,
					headers,
				}),
				{ headers: { "Content-Type": "application/json" } },
			);
		},
	});
	upstreamPort = upstream.port!;

	proxy = new ForwardProxy({ port: 0 });
	await proxy.start();
	proxyPort = proxy.port;

	// Register 127.0.0.1 with allowlist including our upstream
	proxy.addInstance("127.0.0.1", {
		allowlist: [
			"localhost",
			"127.0.0.1",
			"allowed.example.com",
			"*.allowed.io",
		],
	});
});

afterAll(async () => {
	await proxy.stop();
	upstream.stop(true);
});

describe("ForwardProxy", () => {
	describe("HTTP forwarding", () => {
		test("forwards allowed HTTP request to upstream", async () => {
			const response = await rawRequest(
				proxyPort,
				`GET http://127.0.0.1:${upstreamPort}/hello HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\n\r\n`,
			);
			expect(response).toContain("200");
			expect(response).toContain("/hello");
		});

		test("rejects HTTP request to disallowed host", async () => {
			const response = await rawRequest(
				proxyPort,
				`GET http://evil.com/hack HTTP/1.1\r\nHost: evil.com\r\n\r\n`,
			);
			expect(response).toContain("403");
		});
	});

	describe("HTTPS CONNECT", () => {
		test("rejects CONNECT to disallowed host", async () => {
			const response = await rawRequest(
				proxyPort,
				`CONNECT evil.com:443 HTTP/1.1\r\nHost: evil.com:443\r\n\r\n`,
			);
			expect(response).toContain("403");
		});

		test("accepts CONNECT to allowed host", async () => {
			const response = await rawRequest(
				proxyPort,
				`CONNECT allowed.example.com:443 HTTP/1.1\r\nHost: allowed.example.com:443\r\n\r\n`,
				{ timeout: 500 },
			);
			// Should get 200 Connection Established (even if TLS handshake fails after)
			expect(response).toContain("200");
		});
	});

	describe("source IP routing", () => {
		test("unknown source IP gets rejected", async () => {
			// We can only test from 127.0.0.1 directly, so test via removeInstance
			proxy.removeInstance("127.0.0.1");

			const response = await rawRequest(
				proxyPort,
				`GET http://localhost:${upstreamPort}/ HTTP/1.1\r\nHost: localhost\r\n\r\n`,
			);
			expect(response).toContain("403");

			// Restore for remaining tests
			proxy.addInstance("127.0.0.1", {
				allowlist: [
					"localhost",
					"127.0.0.1",
					"allowed.example.com",
					"*.allowed.io",
				],
			});
		});
	});

	describe("instance management", () => {
		test("addInstance/removeInstance updates routing table", () => {
			proxy.addInstance("10.0.0.1", { allowlist: ["example.com"] });
			proxy.removeInstance("10.0.0.1");
			// No error = success (routing table internals tested via integration)
		});
	});

	describe("credential injection", () => {
		test("HTTP request to credentialed domain gets headers injected", async () => {
			// Set up a dedicated proxy with credentials pointing to our echo upstream
			const credProxy = new ForwardProxy({
				port: 0,
				secretResolver: (_tenantId, template) => {
					// Simple test resolver: ${tenant-secret:TEST_KEY} -> "resolved-secret"
					return template.replace(
						/\$\{(?:global-secret|tenant-secret):(\w+)\}/g,
						() => "resolved-secret",
					);
				},
			});
			await credProxy.start();

			credProxy.addInstance("127.0.0.1", {
				allowlist: ["127.0.0.1"],
				credentials: [
					{
						domain: "127.0.0.1",
						headers: { "x-api-key": "${tenant-secret:TEST_KEY}" },
					},
				],
				tenantId: "test-tenant",
			});

			const response = await rawRequest(
				credProxy.port,
				`GET http://127.0.0.1:${upstreamPort}/test HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\n\r\n`,
			);

			expect(response).toContain("200");
			expect(response).toContain("resolved-secret");

			await credProxy.stop();
		});

		test("CONNECT to credentialed domain is rejected (403)", async () => {
			const credProxy = new ForwardProxy({ port: 0 });
			await credProxy.start();

			credProxy.addInstance("127.0.0.1", {
				allowlist: ["api.example.com"],
				credentials: [
					{
						domain: "api.example.com",
						headers: { "x-api-key": "${tenant-secret:KEY}" },
					},
				],
			});

			const response = await rawRequest(
				credProxy.port,
				`CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n`,
			);
			expect(response).toContain("403");
			expect(response).toContain("credential");

			await credProxy.stop();
		});

		test("replaces client-sent headers that match injected credential headers", async () => {
			const credProxy = new ForwardProxy({
				port: 0,
				secretResolver: (_tenantId, template) => {
					return template.replace(
						/\$\{(?:global-secret|tenant-secret):(\w+)\}/g,
						() => "real-secret-value",
					);
				},
			});
			await credProxy.start();

			credProxy.addInstance("127.0.0.1", {
				allowlist: ["127.0.0.1"],
				credentials: [
					{
						domain: "127.0.0.1",
						headers: { "x-api-key": "${tenant-secret:API_KEY}" },
					},
				],
				tenantId: "test-tenant",
			});

			// Client sends its own x-api-key header (e.g. a dummy placeholder)
			const response = await rawRequest(
				credProxy.port,
				`GET http://127.0.0.1:${upstreamPort}/test HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\nx-api-key: sk-ant-dummy-placeholder\r\n\r\n`,
			);

			expect(response).toContain("200");
			// The real secret should be present
			expect(response).toContain("real-secret-value");
			// The dummy placeholder should NOT be present
			expect(response).not.toContain("sk-ant-dummy-placeholder");

			await credProxy.stop();
		});

		test("direct request with credential rule attempts upstream TLS connection", async () => {
			const credProxy = new ForwardProxy({
				port: 0,
				secretResolver: (_tenantId, template) => {
					return template.replace(
						/\$\{(?:global-secret|tenant-secret):(\w+)\}/g,
						() => "direct-mode-secret",
					);
				},
			});
			await credProxy.start();

			credProxy.addInstance("127.0.0.1", {
				allowlist: [],
				credentials: [
					{
						domain: "api.example.com",
						headers: { "x-api-key": "${tenant-secret:API_KEY}" },
					},
				],
				tenantId: "test-tenant",
			});

			// Send a direct request (relative URL) — simulates Node.js fetch()
			// when ANTHROPIC_BASE_URL points at the proxy.
			// The proxy resolves upstream from the credential rule and tries to
			// connect to api.example.com:443 over TLS. In tests there's no such
			// server, so we expect a 502 (proves direct mode activated).
			const response = await rawRequest(
				credProxy.port,
				`POST /v1/messages HTTP/1.1\r\nHost: host.containers.internal:18080\r\nContent-Length: 0\r\n\r\n`,
			);

			expect(response).toContain("502");

			await credProxy.stop();
		});

		test("direct request without credential rule returns 400", async () => {
			const credProxy = new ForwardProxy({ port: 0 });
			await credProxy.start();

			credProxy.addInstance("127.0.0.1", {
				allowlist: ["example.com"],
				credentials: [],
			});

			const response = await rawRequest(
				credProxy.port,
				`GET /v1/messages HTTP/1.1\r\nHost: host.containers.internal:18080\r\n\r\n`,
			);

			expect(response).toContain("400");

			await credProxy.stop();
		});

		test("non-credentialed domains still work normally", async () => {
			const credProxy = new ForwardProxy({ port: 0 });
			await credProxy.start();

			credProxy.addInstance("127.0.0.1", {
				allowlist: ["127.0.0.1", "other.example.com"],
				credentials: [
					{
						domain: "other.example.com",
						headers: { "x-api-key": "${tenant-secret:KEY}" },
					},
				],
			});

			// HTTP to non-credentialed domain works
			const response = await rawRequest(
				credProxy.port,
				`GET http://127.0.0.1:${upstreamPort}/hello HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\n\r\n`,
			);
			expect(response).toContain("200");
			expect(response).not.toContain("x-api-key");

			await credProxy.stop();
		});
	});
});
