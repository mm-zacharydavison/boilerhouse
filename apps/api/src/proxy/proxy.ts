import type { Socket, TCPSocketListener } from "bun";
import { matchesDomain } from "./matcher";

interface ForwardProxyConfig {
	/** Port to listen on. Use 0 for an ephemeral port. */
	port: number;
}

interface SocketState {
	buffer: Buffer;
	phase: "header" | "tunnel";
	upstream: Socket<UpstreamState> | null;
}

interface UpstreamState {
	peer: Socket<SocketState>;
}

/**
 * A forward proxy that routes traffic based on source IP.
 *
 * Each registered source IP has an allowlist of permitted destination domains.
 * HTTP requests are forwarded if the Host header matches the allowlist.
 * HTTPS CONNECT tunnels are permitted if the target host matches.
 * Unknown source IPs are fail-closed (403).
 */
export class ForwardProxy {
	private readonly config: ForwardProxyConfig;
	private readonly routingTable = new Map<string, string[]>();
	private server: TCPSocketListener<SocketState> | null = null;

	/** The actual port the proxy is listening on (useful when config.port is 0). */
	get port(): number {
		if (!this.server) throw new Error("Proxy not started");
		return this.server.port;
	}

	constructor(config: ForwardProxyConfig) {
		this.config = config;
	}

	async start(): Promise<void> {
		this.server = Bun.listen<SocketState>({
			hostname: "0.0.0.0",
			port: this.config.port,
			socket: {
				open: (socket) => {
					socket.data = {
						buffer: Buffer.alloc(0),
						phase: "header",
						upstream: null,
					};
				},
				data: (socket, data) => {
					this.handleData(socket, Buffer.from(data));
				},
				error: (_socket, error) => {
					console.error("[proxy] socket error:", error.message);
				},
				close: (socket) => {
					socket.data.upstream?.end();
				},
			},
		});
	}

	async stop(): Promise<void> {
		this.server?.stop(true);
		this.server = null;
	}

	/** Register a source IP with its allowed domain list. */
	addInstance(sourceIp: string, allowlist: string[]): void {
		this.routingTable.set(sourceIp, allowlist);
	}

	/** Remove a source IP from the routing table. */
	removeInstance(sourceIp: string): void {
		this.routingTable.delete(sourceIp);
	}

	private handleData(socket: Socket<SocketState>, data: Buffer): void {
		// In tunnel mode, forward raw bytes to upstream
		if (socket.data.phase === "tunnel") {
			socket.data.upstream?.write(data);
			return;
		}

		// Header phase: buffer until we see \r\n\r\n
		socket.data.buffer = Buffer.concat([socket.data.buffer, data]);
		const buf = socket.data.buffer;

		const headerEnd = buf.indexOf("\r\n\r\n");
		if (headerEnd === -1) return; // Need more data

		const headerStr = buf.subarray(0, headerEnd).toString();
		const lines = headerStr.split("\r\n");
		const requestLine = lines[0]!;
		const [method, target] = requestLine.split(" ");

		// Look up source IP allowlist
		const sourceIp = socket.remoteAddress;
		const allowlist = this.routingTable.get(sourceIp);
		if (!allowlist) {
			socket.write(
				"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\nForbidden: unknown source IP\r\n",
			);
			socket.end();
			return;
		}

		if (method === "CONNECT") {
			this.handleConnect(socket, target!, allowlist);
		} else {
			this.handleHttp(socket, buf, headerEnd, target!, lines, allowlist);
		}
	}

	private handleConnect(
		socket: Socket<SocketState>,
		target: string,
		allowlist: string[],
	): void {
		const host = target.split(":")[0]!;

		if (!matchesDomain(host, allowlist)) {
			socket.write(
				"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\nForbidden: domain not allowed\r\n",
			);
			socket.end();
			return;
		}

		const [targetHost, targetPortStr] = target.split(":");
		const targetPort = parseInt(targetPortStr ?? "443", 10);

		socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		socket.data.phase = "tunnel";
		socket.data.buffer = Buffer.alloc(0);

		Bun.connect<UpstreamState>({
			hostname: targetHost!,
			port: targetPort,
			socket: {
				open: (upstream) => {
					upstream.data = { peer: socket };
					socket.data.upstream = upstream;
				},
				data: (_upstream, chunk) => {
					socket.write(chunk);
				},
				close: () => {
					socket.end();
				},
				error: () => {
					socket.end();
				},
			},
		}).catch(() => {
			socket.end();
		});
	}

	private handleHttp(
		socket: Socket<SocketState>,
		fullData: Buffer,
		headerEnd: number,
		target: string,
		headerLines: string[],
		allowlist: string[],
	): void {
		// Extract host from Host header or URL
		let host: string | undefined;

		for (const line of headerLines) {
			if (line.toLowerCase().startsWith("host:")) {
				host = line.slice(5).trim().split(":")[0];
				break;
			}
		}

		if (!host && target.startsWith("http://")) {
			try {
				host = new URL(target).hostname;
			} catch {
				// invalid URL
			}
		}

		if (!host || !matchesDomain(host, allowlist)) {
			socket.write(
				"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\nForbidden: domain not allowed\r\n",
			);
			socket.end();
			return;
		}

		let upstreamHost: string;
		let upstreamPort: number;
		let path: string;

		try {
			const url = new URL(target);
			upstreamHost = url.hostname;
			upstreamPort = url.port ? parseInt(url.port, 10) : 80;
			path = url.pathname + url.search;
		} catch {
			socket.write(
				"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nBad request URL\r\n",
			);
			socket.end();
			return;
		}

		// Rewrite the request line to use a relative path
		const method = headerLines[0]!.split(" ")[0];
		const version = headerLines[0]!.split(" ")[2];
		const rewrittenRequestLine = `${method} ${path} ${version}`;
		const rewrittenHeaders = [
			rewrittenRequestLine,
			...headerLines.slice(1),
		];
		const rewrittenHead = rewrittenHeaders.join("\r\n") + "\r\n\r\n";

		const body = fullData.subarray(headerEnd + 4);
		const payload = Buffer.concat([Buffer.from(rewrittenHead), body]);

		Bun.connect<Record<string, never>>({
			hostname: upstreamHost,
			port: upstreamPort,
			socket: {
				open: (upstream) => {
					upstream.write(payload);
				},
				data: (_upstream, chunk) => {
					socket.write(chunk);
				},
				close: () => {
					socket.end();
				},
				error: () => {
					socket.write(
						"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\nUpstream connection failed\r\n",
					);
					socket.end();
				},
			},
		}).catch(() => {
			socket.write(
				"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\nUpstream connection failed\r\n",
			);
			socket.end();
		});
	}
}
