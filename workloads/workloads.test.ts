import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { parseWorkload } from "../packages/core/src/workload";

const WORKLOADS_DIR = new URL(".", import.meta.url).pathname;

describe("workload definitions", () => {
	const glob = new Glob("**/*.toml");
	const files = Array.from(glob.scanSync({ cwd: WORKLOADS_DIR }));

	test("at least one .toml file exists", () => {
		expect(files.length).toBeGreaterThan(0);
	});

	for (const file of files) {
		test(`${file} parses without errors`, async () => {
			const content = await Bun.file(`${WORKLOADS_DIR}${file}`).text();
			expect(() => parseWorkload(content)).not.toThrow();
		});
	}
});
