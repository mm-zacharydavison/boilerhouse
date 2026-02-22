import { describe, test, expect } from "bun:test";
import { resolveImagePath } from "./image-path";
import type { Workload } from "./workload";

const BASE_WORKLOAD: Workload = {
	workload: { name: "test", version: "1.0.0" },
	image: { ref: "alpine:latest" },
	resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
	network: { access: "none" },
	idle: { action: "hibernate" },
};

describe("resolveImagePath", () => {
	test("maps image.ref to ref-based path", () => {
		const result = resolveImagePath("/images", BASE_WORKLOAD);
		expect(result).toBe("/images/alpine/latest/rootfs.ext4");
	});

	test("handles namespaced image refs", () => {
		const workload: Workload = { ...BASE_WORKLOAD, image: { ref: "alpine/openclaw:main" } };
		const result = resolveImagePath("/images", workload);
		expect(result).toBe("/images/alpine/openclaw/main/rootfs.ext4");
	});

	test("maps image.dockerfile to _builds/name/version path", () => {
		const workload: Workload = {
			...BASE_WORKLOAD,
			image: { dockerfile: "minimal/Dockerfile" },
		};
		const result = resolveImagePath("/images", workload);
		expect(result).toBe("/images/_builds/test/1.0.0/rootfs.ext4");
	});

	test("throws when neither ref nor dockerfile is set", () => {
		const workload = { ...BASE_WORKLOAD, image: {} } as Workload;
		expect(() => resolveImagePath("/images", workload)).toThrow(
			"Workload must specify either image.ref or image.dockerfile",
		);
	});
});
