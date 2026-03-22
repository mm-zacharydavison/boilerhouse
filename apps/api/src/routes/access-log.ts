import { Elysia } from "elysia";
import type { Logger } from "@boilerhouse/o11y";

/**
 * Elysia plugin that logs every HTTP request with method, path, status, IP,
 * and duration. Mount early in the plugin chain.
 *
 * Uses `onAfterResponse` so that *all* responses are logged — including
 * Elysia validation rejections (422) which bypass `onAfterHandle`/`onError`.
 */
export function accessLog(log: Logger) {
	const startTimes = new WeakMap<Request, number>();
	const requestIps = new WeakMap<Request, string>();

	return new Elysia({ name: "access-log" })
		.onRequest(({ request }) => {
			startTimes.set(request, Date.now());
			requestIps.set(request, extractIp(request));
		})
		.onAfterResponse(({ request, set }) => {
			const status = typeof set.status === "number" ? set.status : 200;
			const url = new URL(request.url);
			const start = startTimes.get(request);
			const ip = requestIps.get(request) ?? "unknown";
			const durationMs = start != null ? Date.now() - start : undefined;
			const logFn = status >= 400 ? log.warn.bind(log) : log.info.bind(log);
			logFn({
				method: request.method,
				path: url.pathname,
				status,
				ip,
				durationMs,
			}, `${request.method} ${url.pathname} ${status}`);
		});
}

function extractIp(request: Request): string {
	return (
		request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
		request.headers.get("x-real-ip") ??
		"unknown"
	);
}
