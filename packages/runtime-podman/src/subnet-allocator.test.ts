import { describe, test, expect, beforeEach } from "bun:test";
import { SubnetAllocator } from "./subnet-allocator";

describe("SubnetAllocator", () => {
	let alloc: SubnetAllocator;

	beforeEach(() => {
		alloc = new SubnetAllocator();
	});

	test("allocates first subnet as 10.89.0.0/30", () => {
		expect(alloc.allocate("inst-a")).toBe("10.89.0.0/30");
	});

	test("allocates second subnet as 10.89.0.4/30", () => {
		alloc.allocate("inst-a");
		expect(alloc.allocate("inst-b")).toBe("10.89.0.4/30");
	});

	test("is idempotent for the same instanceId", () => {
		const first = alloc.allocate("inst-a");
		const second = alloc.allocate("inst-a");
		expect(first).toBe(second);
	});

	test("assigns unique subnets to different instances", () => {
		const subnets = new Set<string>();
		for (let i = 0; i < 100; i++) {
			subnets.add(alloc.allocate(`inst-${i}`));
		}
		expect(subnets.size).toBe(100);
	});

	test("subnet at index 63 is 10.89.0.252/30", () => {
		for (let i = 0; i < 63; i++) {
			alloc.allocate(`inst-${i}`);
		}
		expect(alloc.allocate("inst-63")).toBe("10.89.0.252/30");
	});

	test("subnet at index 64 rolls over to 10.89.1.0/30", () => {
		for (let i = 0; i < 64; i++) {
			alloc.allocate(`inst-${i}`);
		}
		expect(alloc.allocate("inst-64")).toBe("10.89.1.0/30");
	});

	test("last subnet (index 16383) is 10.89.255.252/30", () => {
		for (let i = 0; i < 16383; i++) {
			alloc.allocate(`inst-${i}`);
		}
		expect(alloc.allocate("inst-16383")).toBe("10.89.255.252/30");
	});

	test("throws when pool is exhausted", () => {
		for (let i = 0; i < SubnetAllocator.POOL_SIZE; i++) {
			alloc.allocate(`inst-${i}`);
		}
		expect(() => alloc.allocate("inst-overflow")).toThrow("exhausted");
	});

	test("freed subnets are reused", () => {
		const subnet0 = alloc.allocate("inst-a");
		alloc.allocate("inst-b");

		alloc.free("inst-a");
		const reused = alloc.allocate("inst-c");
		expect(reused).toBe(subnet0);
	});

	test("free() is idempotent for unknown instanceId", () => {
		expect(() => alloc.free("nonexistent")).not.toThrow();
	});

	test("has() returns false before allocation", () => {
		expect(alloc.has("inst-a")).toBe(false);
	});

	test("has() returns true after allocation", () => {
		alloc.allocate("inst-a");
		expect(alloc.has("inst-a")).toBe(true);
	});

	test("has() returns false after free", () => {
		alloc.allocate("inst-a");
		alloc.free("inst-a");
		expect(alloc.has("inst-a")).toBe(false);
	});

	test("BASE_CIDR covers all subnets", () => {
		expect(SubnetAllocator.BASE_CIDR).toBe("10.89.0.0/16");
	});
});
