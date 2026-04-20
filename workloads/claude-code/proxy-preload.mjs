// Installed via NODE_OPTIONS=--import=/app/proxy-preload.mjs so every child
// Node process (including the claude CLI that bridge.mjs spawns) routes its
// fetch/undici traffic through the Envoy sidecar. Without this, Node does
// NOT honour HTTP_PROXY / HTTPS_PROXY for requests made via globalThis.fetch
// or the built-in `https` module, and claude-code silently bypasses the
// boilerhouse credential-injection proxy.
import { setGlobalDispatcher, ProxyAgent } from "undici";

const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
if (proxy) {
	setGlobalDispatcher(new ProxyAgent(proxy));
}
