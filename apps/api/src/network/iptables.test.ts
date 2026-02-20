import { describe, test, expect } from "bun:test";
import type { InstanceId } from "@boilerhouse/core";
import { IptablesManager } from "./iptables";
import type { TapDevice } from "./tap";

const manager = new IptablesManager();

const TAP: TapDevice = {
	name: "tap-abc12345",
	ip: "172.16.0.1",
	mac: "02:ab:cd:ef:01:23",
};

const INSTANCE_ID = "inst-001" as InstanceId;
const GUEST_IP = "172.16.0.2";

describe("IptablesManager", () => {
	describe("setupForInstance() — none", () => {
		test("returns empty array for 'none' access", () => {
			const rules = manager.setupForInstance(
				INSTANCE_ID,
				TAP,
				GUEST_IP,
				"none",
			);
			expect(rules).toEqual([]);
		});
	});

	describe("setupForInstance() — outbound", () => {
		test("includes FORWARD rules for TAP device", () => {
			const rules = manager.setupForInstance(
				INSTANCE_ID,
				TAP,
				GUEST_IP,
				"outbound",
			);
			const forwardRules = rules.filter((r) => r.includes("FORWARD"));
			expect(forwardRules.length).toBeGreaterThanOrEqual(2);
			expect(forwardRules.some((r) => r.includes("-i " + TAP.name))).toBe(
				true,
			);
			expect(forwardRules.some((r) => r.includes("-o " + TAP.name))).toBe(
				true,
			);
		});

		test("includes MASQUERADE rule", () => {
			const rules = manager.setupForInstance(
				INSTANCE_ID,
				TAP,
				GUEST_IP,
				"outbound",
			);
			expect(rules.some((r) => r.includes("MASQUERADE"))).toBe(true);
		});

		test("all rules include boilerhouse comment with instanceId", () => {
			const rules = manager.setupForInstance(
				INSTANCE_ID,
				TAP,
				GUEST_IP,
				"outbound",
			);
			for (const rule of rules) {
				expect(rule).toContain(`boilerhouse:${INSTANCE_ID}`);
			}
		});
	});

	describe("setupForInstance() — restricted", () => {
		test("includes DNAT rules redirecting 80/443 to proxy", () => {
			const rules = manager.setupForInstance(
				INSTANCE_ID,
				TAP,
				GUEST_IP,
				"restricted",
				{ proxyPort: 8080 },
			);
			const dnatRules = rules.filter((r) => r.includes("DNAT"));
			expect(dnatRules.some((r) => r.includes("--dport 80"))).toBe(true);
			expect(dnatRules.some((r) => r.includes("--dport 443"))).toBe(true);
			expect(dnatRules.some((r) => r.includes(":8080"))).toBe(true);
		});

		test("also includes FORWARD and MASQUERADE rules", () => {
			const rules = manager.setupForInstance(
				INSTANCE_ID,
				TAP,
				GUEST_IP,
				"restricted",
				{ proxyPort: 8080 },
			);
			expect(rules.some((r) => r.includes("FORWARD"))).toBe(true);
			expect(rules.some((r) => r.includes("MASQUERADE"))).toBe(true);
		});
	});

	describe("setupForInstance() — port mappings", () => {
		test("adds DNAT rules for port exposures", () => {
			const rules = manager.setupForInstance(
				INSTANCE_ID,
				TAP,
				GUEST_IP,
				"outbound",
				{
					portMappings: [{ hostPort: 8080, guestPort: 80 }],
				},
			);
			const dnatRules = rules.filter(
				(r) => r.includes("DNAT") && r.includes("--dport 8080"),
			);
			expect(dnatRules).toHaveLength(1);
			expect(dnatRules[0]).toContain(`${GUEST_IP}:80`);
		});
	});

	describe("teardownForInstance()", () => {
		test("replaces -A with -D in all setup commands", () => {
			manager.setupForInstance(
				INSTANCE_ID,
				TAP,
				GUEST_IP,
				"outbound",
			);
			const teardown = manager.teardownForInstance(INSTANCE_ID);
			expect(teardown.length).toBeGreaterThan(0);
			for (const rule of teardown) {
				expect(rule).toContain(" -D ");
				expect(rule).not.toContain(" -A ");
			}
		});

		test("returns empty for unknown instance", () => {
			const teardown = manager.teardownForInstance(
				"unknown" as InstanceId,
			);
			expect(teardown).toEqual([]);
		});

		test("clears stored rules after teardown", () => {
			manager.setupForInstance(
				"inst-clear" as InstanceId,
				TAP,
				GUEST_IP,
				"outbound",
			);
			manager.teardownForInstance("inst-clear" as InstanceId);
			// Second teardown should return empty
			const second = manager.teardownForInstance(
				"inst-clear" as InstanceId,
			);
			expect(second).toEqual([]);
		});
	});
});
