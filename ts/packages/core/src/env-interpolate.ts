const ENV_VAR_RE = /\$\{(\w+)\}/g;

/**
 * Replace `${VAR}` references in a string with values from `process.env`.
 * Unresolved variables are replaced with an empty string.
 *
 * An optional `skip` predicate can preserve certain matches (e.g. secret refs)
 * by returning `true` — the original `${...}` token is kept as-is.
 */
export function interpolateEnvString(
	value: string,
	skip?: (match: string, name: string) => boolean,
): string {
	return value.replace(ENV_VAR_RE, (match, name: string) => {
		if (skip?.(match, name)) return match;
		return process.env[name] ?? "";
	});
}

/**
 * Recursively interpolate `${VAR}` references in all string values
 * within an arbitrarily nested object/array structure.
 */
export function interpolateEnv<T>(
	value: T,
	skip?: (match: string, name: string) => boolean,
): T {
	if (typeof value === "string") {
		return interpolateEnvString(value, skip) as T;
	}
	if (Array.isArray(value)) {
		return value.map((v) => interpolateEnv(v, skip)) as T;
	}
	if (value && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			result[k] = interpolateEnv(v, skip);
		}
		return result as T;
	}
	return value;
}
