import { Elysia } from "elysia";

interface RateLimitOptions {
	/** Maximum requests per window. @default 60 */
	max?: number;
	/** Window size in milliseconds. @default 60_000 */
	windowMs?: number;
}

interface Entry {
	count: number;
	resetAt: number;
}

/**
 * IP-based sliding-window rate limiter. Returns 429 when exceeded.
 */
export function rateLimit(opts: RateLimitOptions = {}) {
	const max = opts.max ?? 60;
	const windowMs = opts.windowMs ?? 60_000;
	const buckets = new Map<string, Entry>();

	// Periodic cleanup of expired entries
	const cleanup = setInterval(() => {
		const now = Date.now();
		for (const [key, entry] of buckets) {
			if (now >= entry.resetAt) buckets.delete(key);
		}
	}, windowMs * 2);
	cleanup.unref();

	return new Elysia({ name: "rate-limit" }).onRequest(({ request, set }) => {
		const ip =
			request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
			request.headers.get("x-real-ip") ??
			"unknown";

		const now = Date.now();
		let entry = buckets.get(ip);

		if (!entry || now >= entry.resetAt) {
			entry = { count: 0, resetAt: now + windowMs };
			buckets.set(ip, entry);
		}

		entry.count++;

		set.headers["X-RateLimit-Limit"] = String(max);
		set.headers["X-RateLimit-Remaining"] = String(Math.max(0, max - entry.count));
		set.headers["X-RateLimit-Reset"] = String(Math.ceil(entry.resetAt / 1000));

		if (entry.count > max) {
			set.status = 429;
			set.headers["Retry-After"] = String(Math.ceil((entry.resetAt - now) / 1000));
			return { error: "Too many requests" };
		}
	});
}
