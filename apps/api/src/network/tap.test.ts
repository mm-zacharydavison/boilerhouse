import { describe, test, expect } from "bun:test";
import type { InstanceId } from "@boilerhouse/core";
import { TapManager } from "./tap";

const manager = new TapManager();

describe("TapManager", () => {
	describe("createCommands()", () => {
		test("returns a TapDevice with name, ip, and mac", () => {
			const { device } = manager.createCommands("inst-001" as InstanceId);
			expect(device.name).toMatch(/^tap-[0-9a-f]{8}$/);
			expect(device.ip).toMatch(/^172\.\d+\.\d+\.\d+$/);
			expect(device.mac).toMatch(/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/);
		});

		test("TAP name is within IFNAMSIZ (15 chars)", () => {
			const { device } = manager.createCommands("inst-001" as InstanceId);
			expect(device.name.length).toBeLessThanOrEqual(15);
		});

		test("generates deterministic output for the same instanceId", () => {
			const a = manager.createCommands("inst-001" as InstanceId);
			const b = manager.createCommands("inst-001" as InstanceId);
			expect(a.device).toEqual(b.device);
			expect(a.commands).toEqual(b.commands);
		});

		test("generates different output for different instanceIds", () => {
			const a = manager.createCommands("inst-001" as InstanceId);
			const b = manager.createCommands("inst-002" as InstanceId);
			expect(a.device.name).not.toBe(b.device.name);
		});

		test("commands include tuntap add, addr add, and link set up", () => {
			const { commands, device } = manager.createCommands(
				"inst-001" as InstanceId,
			);
			expect(commands.some((c) => c.includes("ip tuntap add"))).toBe(true);
			expect(commands.some((c) => c.includes("ip addr add"))).toBe(true);
			expect(commands.some((c) => c.includes("ip link set"))).toBe(true);
			expect(
				commands.some((c) => c.includes(device.name) && c.includes("up")),
			).toBe(true);
		});

		test("IP address is in 172.16.0.0/12 range with /30 subnet", () => {
			const { device } = manager.createCommands("inst-001" as InstanceId);
			const parts = device.ip.split(".").map(Number);
			// 172.16.0.0/12 means first octet=172, second 16-31
			expect(parts[0]).toBe(172);
			expect(parts[1]).toBeGreaterThanOrEqual(16);
			expect(parts[1]).toBeLessThanOrEqual(31);
		});

		test("MAC has locally-administered bit set", () => {
			const { device } = manager.createCommands("inst-001" as InstanceId);
			const firstByte = parseInt(device.mac.split(":")[0]!, 16);
			// Locally administered: bit 1 of first byte is set
			expect(firstByte & 0x02).toBe(0x02);
			// Unicast: bit 0 of first byte is cleared
			expect(firstByte & 0x01).toBe(0x00);
		});
	});

	describe("destroyCommands()", () => {
		test("returns ip link delete command", () => {
			const { device } = manager.createCommands("inst-001" as InstanceId);
			const commands = manager.destroyCommands(device);
			expect(commands).toHaveLength(1);
			expect(commands[0]).toContain("ip link delete");
			expect(commands[0]).toContain(device.name);
		});
	});
});
