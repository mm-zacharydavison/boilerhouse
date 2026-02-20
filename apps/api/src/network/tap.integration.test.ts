import { describe, test, expect } from "bun:test";
import type { InstanceId } from "@boilerhouse/core";
import { TapManager } from "./tap";

describe.skipIf(!process.env.BOILERHOUSE_INTEGRATION)(
	"TapManager integration",
	() => {
		const manager = new TapManager();
		const instanceId = "integration-tap-test" as InstanceId;

		test("create() makes a TAP device visible to the system", async () => {
			const device = await manager.create(instanceId);

			try {
				// Verify device exists
				const proc = Bun.spawn(
					["ip", "link", "show", device.name],
					{ stdout: "pipe", stderr: "pipe" },
				);
				const exitCode = await proc.exited;
				expect(exitCode).toBe(0);

				const output = await new Response(proc.stdout).text();
				expect(output).toContain(device.name);
				expect(output).toContain("UP");
			} finally {
				await manager.destroy(device);
			}
		});

		test("destroy() removes the TAP device", async () => {
			const device = await manager.create(instanceId);
			await manager.destroy(device);

			const proc = Bun.spawn(
				["ip", "link", "show", device.name],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const exitCode = await proc.exited;
			expect(exitCode).not.toBe(0);
		});
	},
);
