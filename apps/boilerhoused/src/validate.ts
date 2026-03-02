import type { ContainerCreateSpec } from "@boilerhouse/runtime-podman";

export class PolicyViolationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PolicyViolationError";
	}
}

/**
 * Validates a container create spec against the daemon's security policy.
 * Throws `PolicyViolationError` if any rule is violated.
 *
 * Returns a sanitized copy of the spec with enforced labels and privileged=false.
 */
export function validateContainerSpec(spec: ContainerCreateSpec): ContainerCreateSpec {
	if (spec.privileged === true) {
		throw new PolicyViolationError("Privileged containers are not allowed");
	}

	if (spec.netns?.nsmode === "host") {
		throw new PolicyViolationError("Host network namespace is not allowed");
	}

	if (spec.portmappings) {
		for (const pm of spec.portmappings) {
			if (pm.host_port !== 0) {
				throw new PolicyViolationError(
					`Fixed host_port ${pm.host_port} is not allowed — use 0 for ephemeral allocation`,
				);
			}
		}
	}

	if (spec.mounts) {
		for (const mount of spec.mounts) {
			if (mount.type === "bind") {
				throw new PolicyViolationError(
					`Bind mount to ${mount.destination} is not allowed`,
				);
			}
		}
	}

	return {
		...spec,
		privileged: false,
		labels: {
			...spec.labels,
			"managed-by": "boilerhoused",
		},
	};
}
