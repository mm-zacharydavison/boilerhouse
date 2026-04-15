/**
 * Checks whether a domain matches any entry in an allowlist.
 *
 * Supports:
 * - Exact matches (`api.example.com`)
 * - Wildcard subdomains (`*.example.com`)
 * - Catch-all wildcard (`*`)
 *
 * Matching is case-insensitive.
 */
export function matchesDomain(domain: string, allowlist: string[]): boolean {
	const lower = domain.toLowerCase();

	for (const entry of allowlist) {
		const pattern = entry.toLowerCase();

		if (pattern === "*") {
			return true;
		}

		if (pattern === lower) {
			return true;
		}

		if (pattern.startsWith("*.")) {
			const suffix = pattern.slice(1); // ".example.com"
			if (lower.endsWith(suffix) && lower.length > suffix.length) {
				return true;
			}
		}
	}

	return false;
}
