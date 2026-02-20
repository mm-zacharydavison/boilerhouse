import { describe, test, expect } from "bun:test";
import type { InstanceId } from "@boilerhouse/core";
import { IptablesManager } from "./iptables";
import type { TapDevice } from "./tap";

describe.skipIf(!process.env.BOILERHOUSE_INTEGRATION)(
	"IptablesManager integration",
	() => {
		const manager = new IptablesManager();

		const TAP: TapDevice = {
			name: "tap-inttest0",
			ip: "172.16.99.1",
			mac: "02:00:00:00:99:01",
		};

		const INSTANCE_ID = "integration-ipt-test" as InstanceId;
		const GUEST_IP = "172.16.99.2";

		test("setup and teardown execute without error", async () => {
			const rules = manager.setupForInstance(
				INSTANCE_ID,
				TAP,
				GUEST_IP,
				"outbound",
			);

			// Apply rules
			for (const rule of rules) {
				const proc = Bun.spawn(["sh", "-c", rule], {
					stdout: "pipe",
					stderr: "pipe",
				});
				const exitCode = await proc.exited;
				if (exitCode !== 0) {
					const stderr = await new Response(proc.stderr).text();
					throw new Error(`Rule apply failed: ${rule}\n${stderr}`);
				}
			}

			// Verify rules exist by listing with comment grep
			const listProc = Bun.spawn(
				[
					"sh",
					"-c",
					`iptables -S FORWARD | grep "boilerhouse:${INSTANCE_ID}"`,
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const listOutput = await new Response(listProc.stdout).text();
			expect(listOutput).toContain(`boilerhouse:${INSTANCE_ID}`);

			// Teardown
			const teardown = manager.teardownForInstance(INSTANCE_ID);
			for (const rule of teardown) {
				const proc = Bun.spawn(["sh", "-c", rule], {
					stdout: "pipe",
					stderr: "pipe",
				});
				const exitCode = await proc.exited;
				if (exitCode !== 0) {
					const stderr = await new Response(proc.stderr).text();
					throw new Error(
						`Rule teardown failed: ${rule}\n${stderr}`,
					);
				}
			}

			// Verify rules are gone
			const checkProc = Bun.spawn(
				[
					"sh",
					"-c",
					`iptables -S FORWARD | grep "boilerhouse:${INSTANCE_ID}" || true`,
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const checkOutput = await new Response(checkProc.stdout).text();
			expect(checkOutput).not.toContain(
				`boilerhouse:${INSTANCE_ID}`,
			);
		});
	},
);
