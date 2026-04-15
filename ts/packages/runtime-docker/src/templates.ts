import { interpolateEnv } from "@boilerhouse/core";

const SECRET_REF_RE = /\$\{(global-secret|tenant-secret):\w+\}/;

/**
 * Resolves `${VAR}` references in env values from the host process environment.
 * `${global-secret:NAME}` and `${tenant-secret:NAME}` references are left untouched
 * for later resolution by the proxy.
 * Unresolved `${VAR}` references are replaced with an empty string.
 */
export function resolveTemplates(env: Record<string, string>): Record<string, string> {
	return interpolateEnv(env, (match) => SECRET_REF_RE.test(match));
}

/**
 * Throws if any env value contains a `${global-secret:...}` or `${tenant-secret:...}` reference.
 * Used to ensure secrets never leak into the container environment.
 */
export function assertNoSecretRefs(env: Record<string, string>): void {
	for (const [key, value] of Object.entries(env)) {
		if (SECRET_REF_RE.test(value)) {
			throw new TemplateError(
				`Environment variable '${key}' contains a secret reference — secrets must not be passed as container env vars`,
			);
		}
	}
}

export class TemplateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TemplateError";
	}
}
