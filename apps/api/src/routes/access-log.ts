import { Elysia } from "elysia";
import type { Logger } from "@boilerhouse/o11y";

/**
 * Elysia plugin that logs every HTTP request with method, path, status, IP,
 * and duration. Mount early in the plugin chain.
 */
export function accessLog(log: Logger) {
	return new Elysia({ name: "access-log" })
		.derive(({ request }) => {
			return { requestStart: Date.now(), requestIp: extractIp(request) };
		})
		.onAfterHandle(({ request, set, requestStart, requestIp }) => {
			const status = typeof set.status === "number" ? set.status : 200;
			const url = new URL(request.url);
			log.info({
				method: request.method,
				path: url.pathname,
				status,
				ip: requestIp,
				durationMs: Date.now() - requestStart,
			}, `${request.method} ${url.pathname} ${status}`);
		})
		.onError(({ request, set, error, requestStart, requestIp }) => {
			const status = typeof set.status === "number" ? set.status : 500;
			const url = new URL(request.url);
			log.warn({
				method: request.method,
				path: url.pathname,
				status,
				ip: requestIp,
				durationMs: Date.now() - (requestStart ?? Date.now()),
				error: error instanceof Error ? error.message : String(error),
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
