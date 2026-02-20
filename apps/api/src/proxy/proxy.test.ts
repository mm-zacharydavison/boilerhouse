import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ForwardProxy } from "./proxy";
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
	// Mock upstream HTTP server
	upstream = Bun.serve({
		port: 0,
		fetch(req) {
			return new Response(`upstream:${new URL(req.url).pathname}`);
		},
	});
	upstreamPort = upstream.port!;

	proxy = new ForwardProxy({ port: 0 });
	await proxy.start();
	proxyPort = proxy.port;

	// Register 127.0.0.1 with allowlist including our upstream
	proxy.addInstance("127.0.0.1", [
		"localhost",
		"127.0.0.1",
		"allowed.example.com",
		"*.allowed.io",
	]);
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
			expect(response).toContain("upstream:/hello");
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
			proxy.addInstance("127.0.0.1", [
				"localhost",
				"127.0.0.1",
				"allowed.example.com",
				"*.allowed.io",
			]);
		});
	});

	describe("instance management", () => {
		test("addInstance/removeInstance updates routing table", () => {
			proxy.addInstance("10.0.0.1", ["example.com"]);
			proxy.removeInstance("10.0.0.1");
			// No error = success (routing table internals tested via integration)
		});
	});
});
