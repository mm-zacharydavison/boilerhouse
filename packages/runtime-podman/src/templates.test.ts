import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { resolveTemplates, assertNoSecretRefs, TemplateError } from "./templates";

describe("resolveTemplates", () => {
	const originalEnv = process.env;

	beforeAll(() => {
		process.env = { ...originalEnv, TEST_VAR: "hello", ANOTHER: "world" };
	});

	afterAll(() => {
		process.env = originalEnv;
	});

	test("resolves ${VAR} from host env", () => {
		const result = resolveTemplates({ KEY: "${TEST_VAR}" });
		expect(result.KEY).toBe("hello");
	});

	test("leaves ${tenant-secret:NAME} untouched", () => {
		const result = resolveTemplates({ KEY: "${tenant-secret:MY_SECRET}" });
		expect(result.KEY).toBe("${tenant-secret:MY_SECRET}");
	});

	test("leaves ${global-secret:NAME} untouched", () => {
		const result = resolveTemplates({ KEY: "${global-secret:PLATFORM_KEY}" });
		expect(result.KEY).toBe("${global-secret:PLATFORM_KEY}");
	});

	test("handles mixed templates", () => {
		const result = resolveTemplates({
			A: "${TEST_VAR}",
			B: "${tenant-secret:API_KEY}",
			C: "prefix-${ANOTHER}-suffix",
			D: "${global-secret:PLATFORM_KEY}",
		});
		expect(result.A).toBe("hello");
		expect(result.B).toBe("${tenant-secret:API_KEY}");
		expect(result.C).toBe("prefix-world-suffix");
		expect(result.D).toBe("${global-secret:PLATFORM_KEY}");
	});

	test("replaces unresolved ${VAR} with empty string", () => {
		const result = resolveTemplates({ KEY: "${NONEXISTENT_VAR_12345}" });
		expect(result.KEY).toBe("");
	});

	test("passes through plain values unchanged", () => {
		const result = resolveTemplates({ KEY: "plain-value" });
		expect(result.KEY).toBe("plain-value");
	});
});

describe("assertNoSecretRefs", () => {
	test("passes when no secret refs present", () => {
		expect(() => assertNoSecretRefs({ KEY: "value", OTHER: "test" })).not.toThrow();
	});

	test("throws TemplateError when ${tenant-secret:...} found", () => {
		expect(() =>
			assertNoSecretRefs({ KEY: "${tenant-secret:MY_SECRET}" }),
		).toThrow(TemplateError);
	});

	test("throws TemplateError when ${global-secret:...} found", () => {
		expect(() =>
			assertNoSecretRefs({ KEY: "${global-secret:PLATFORM_KEY}" }),
		).toThrow(TemplateError);
	});

	test("includes key name in error message", () => {
		expect(() =>
			assertNoSecretRefs({ API_KEY: "${tenant-secret:ANTHROPIC_API_KEY}" }),
		).toThrow(/API_KEY/);
	});

	test("catches secret ref in any value", () => {
		expect(() =>
			assertNoSecretRefs({
				SAFE: "plain",
				DANGER: "prefix-${tenant-secret:TOKEN}-suffix",
			}),
		).toThrow(TemplateError);
	});
});
