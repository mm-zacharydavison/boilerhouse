import type { TenantId, Workload } from "@boilerhouse/core";
import type { ForwardProxy, InstanceRoute, CredentialRule } from "./proxy/proxy";
import type { SecretStore } from "./secret-store";

const TENANT_SECRET_RE = /\$\{tenant-secret:\w+\}/;

/**
 * Manages proxy routing table entries for container instances.
 * Translates workload network config into proxy routes and validates
 * that all referenced secrets exist at registration time (fail-fast).
 */
export class ProxyRegistrar {
	constructor(
		private readonly proxy: ForwardProxy,
		private readonly secretStore: SecretStore,
	) {}

	/**
	 * Register a container IP in the proxy routing table.
	 * Builds the route from the workload's network config.
	 *
	 * `${global-secret:NAME}` refs are always validated (resolved from env).
	 * `${tenant-secret:NAME}` refs are validated only when a tenantId is
	 * present — during golden boot (no tenant), they are skipped.
	 */
	registerInstance(
		sourceIp: string,
		workload: Workload,
		tenantId: TenantId,
	): void {
		const route: InstanceRoute = {
			allowlist: workload.network.allowlist ?? [],
			tenantId,
		};

		if (workload.network.credentials && workload.network.credentials.length > 0) {
			// Validate secrets exist before registering (fail-fast)
			for (const cred of workload.network.credentials) {
				for (const headerTemplate of Object.values(cred.headers)) {
					if (!tenantId && TENANT_SECRET_RE.test(headerTemplate)) {
						// Golden boot: skip tenant-secret validation (no tenant yet)
						continue;
					}
					this.secretStore.resolveSecretRefs(tenantId, headerTemplate);
				}
			}

			route.credentials = workload.network.credentials.map(
				(c): CredentialRule => ({
					domain: c.domain,
					headers: { ...c.headers },
				}),
			);
		}

		this.proxy.addInstance(sourceIp, route);
	}

	/** Remove a container IP from the proxy routing table. */
	deregisterInstance(sourceIp: string): void {
		this.proxy.removeInstance(sourceIp);
	}
}
