import index from "./index.html";

const API_URL = process.env.API_URL ?? "http://localhost:3000";

interface WsData {
	upstream: WebSocket;
}

const server = Bun.serve<WsData>({
	port: Number(process.env.PORT ?? 3001),
	hostname: process.env.LISTEN_HOST ?? "127.0.0.1",
	routes: {
		"/": index,
	},
	fetch(req, server) {
		const url = new URL(req.url);

		// WebSocket upgrade for /ws
		if (url.pathname === "/ws") {
			const wsUrl = new URL("/ws", API_URL.replace(/^http/, "ws"));
			const upstream = new WebSocket(wsUrl.toString());
			const success = server.upgrade(req, { data: { upstream } });
			if (!success) {
				return new Response("WebSocket upgrade failed", { status: 400 });
			}
			return undefined;
		}

		// Proxy /api/* requests to the API server
		if (url.pathname.startsWith("/api/")) {
			const upstream = new URL(url.pathname + url.search, API_URL);
			const headers = new Headers(req.headers);
			headers.delete("host");
			return fetch(upstream.toString(), {
				method: req.method,
				headers,
				body: req.body,
			}).catch(
				() =>
					new Response(JSON.stringify({ error: "Cannot reach API server" }), {
						status: 502,
						headers: { "Content-Type": "application/json" },
					}),
			);
		}

		return new Response("Not found", { status: 404 });
	},
	websocket: {
		open(ws) {
			const { upstream } = ws.data;
			upstream.onmessage = (event) => {
				ws.send(typeof event.data === "string" ? event.data : "");
			};
			upstream.onclose = () => ws.close();
		},
		message(_ws, _message) {
			// Client-to-server messages are not used
		},
		close(ws) {
			ws.data.upstream.close();
		},
	},
	development: process.env.NODE_ENV !== "production" ? {
		hmr: true,
		console: true,
	} : false,
});

console.log(`Dashboard listening on ${server.url}`);
