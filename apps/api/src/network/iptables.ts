import type { InstanceId, NetworkAccess } from "@boilerhouse/core";
import type { TapDevice } from "./tap";

interface SetupOptions {
	/** Port of the forward proxy (required for "restricted" access). */
	proxyPort?: number;
	/** Host-to-guest port mappings for exposed services. */
	portMappings?: Array<{ hostPort: number; guestPort: number }>;
}

/**
 * Generates iptables rules for microVM network isolation.
 *
 * Rules are tagged with `--comment "boilerhouse:<instanceId>"` for
 * identification and reliable teardown.
 */
export class IptablesManager {
	private readonly instanceRules = new Map<InstanceId, string[]>();

	/**
	 * Generates iptables rules for the given instance and access level.
	 *
	 * Returns the list of `iptables` commands to execute. Also stores them
	 * internally so {@link teardownForInstance} can reverse them.
	 */
	setupForInstance(
		instanceId: InstanceId,
		tap: TapDevice,
		guestIp: string,
		access: NetworkAccess,
		options: SetupOptions = {},
	): string[] {
		const rules: string[] = [];
		const comment = `boilerhouse:${instanceId}`;

		if (access === "none") {
			this.instanceRules.set(instanceId, rules);
			return rules;
		}

		// FORWARD rules: allow traffic from/to the TAP device
		rules.push(
			`iptables -A FORWARD -i ${tap.name} -o eth0 -s ${guestIp} -m conntrack --ctstate NEW,ESTABLISHED,RELATED -m comment --comment "${comment}" -j ACCEPT`,
			`iptables -A FORWARD -i eth0 -o ${tap.name} -d ${guestIp} -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment "${comment}" -j ACCEPT`,
		);

		// NAT: MASQUERADE outbound traffic from guest
		rules.push(
			`iptables -t nat -A POSTROUTING -s ${guestIp} -o eth0 -m comment --comment "${comment}" -j MASQUERADE`,
		);

		// Restricted mode: redirect HTTP/HTTPS to the forward proxy
		if (access === "restricted" && options.proxyPort != null) {
			rules.push(
				`iptables -t nat -A PREROUTING -s ${guestIp} -p tcp --dport 80 -m comment --comment "${comment}" -j DNAT --to-destination 127.0.0.1:${options.proxyPort}`,
				`iptables -t nat -A PREROUTING -s ${guestIp} -p tcp --dport 443 -m comment --comment "${comment}" -j DNAT --to-destination 127.0.0.1:${options.proxyPort}`,
			);
		}

		// Port exposure: DNAT from host port to guest port
		if (options.portMappings) {
			for (const mapping of options.portMappings) {
				rules.push(
					`iptables -t nat -A PREROUTING -p tcp --dport ${mapping.hostPort} -m comment --comment "${comment}" -j DNAT --to-destination ${guestIp}:${mapping.guestPort}`,
				);
			}
		}

		this.instanceRules.set(instanceId, rules);
		return rules;
	}

	/**
	 * Generates iptables commands to remove all rules for the given instance.
	 *
	 * Replaces `-A` (append) with `-D` (delete) in each stored rule.
	 * Clears stored rules after generating teardown commands.
	 */
	teardownForInstance(instanceId: InstanceId): string[] {
		const rules = this.instanceRules.get(instanceId);
		if (!rules) return [];

		const teardown = rules.map((rule) => rule.replace(" -A ", " -D "));
		this.instanceRules.delete(instanceId);
		return teardown;
	}
}
