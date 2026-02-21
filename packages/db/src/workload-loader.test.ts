import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq, and } from "drizzle-orm";
import { createTestDatabase } from "./database";
import { workloads } from "./schema";
import { loadWorkloadsFromDir } from "./workload-loader";
import type { DrizzleDb } from "./database";

const VALID_TOML = `
[workload]
name = "test-service"
version = "1.0.0"

[image]
ref = "ghcr.io/test/service:latest"

[resources]
vcpus = 1
memory_mb = 512
`;

const VALID_TOML_2 = `
[workload]
name = "other-service"
version = "2.0.0"

[image]
ref = "ghcr.io/test/other:latest"

[resources]
vcpus = 2
memory_mb = 1024
`;

const UPDATED_TOML = `
[workload]
name = "test-service"
version = "1.0.0"

[image]
ref = "ghcr.io/test/service:latest"

[resources]
vcpus = 4
memory_mb = 2048
`;

const INVALID_TOML = `
[workload]
name = "broken"
`;

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "workload-loader-test-"));
}

function writeToml(dir: string, filename: string, content: string): void {
	Bun.write(join(dir, filename), content);
}

describe("loadWorkloadsFromDir", () => {
	let db: DrizzleDb;

	beforeEach(() => {
		db = createTestDatabase();
	});

	test("loads new workloads into an empty database", () => {
		const dir = makeTempDir();
		writeToml(dir, "svc.toml", VALID_TOML);
		writeToml(dir, "other.toml", VALID_TOML_2);

		const result = loadWorkloadsFromDir(db, dir);

		expect(result.loaded).toBe(2);
		expect(result.updated).toBe(0);
		expect(result.unchanged).toBe(0);
		expect(result.errors).toHaveLength(0);

		const rows = db.select().from(workloads).all();
		expect(rows).toHaveLength(2);

		const names = rows.map((r) => r.name).sort();
		expect(names).toEqual(["other-service", "test-service"]);
	});

	test("skips unchanged workloads on second load", () => {
		const dir = makeTempDir();
		writeToml(dir, "svc.toml", VALID_TOML);

		loadWorkloadsFromDir(db, dir);
		const result = loadWorkloadsFromDir(db, dir);

		expect(result.loaded).toBe(0);
		expect(result.updated).toBe(0);
		expect(result.unchanged).toBe(1);
		expect(result.errors).toHaveLength(0);
	});

	test("updates workloads when config changes", () => {
		const dir = makeTempDir();
		writeToml(dir, "svc.toml", VALID_TOML);

		loadWorkloadsFromDir(db, dir);

		// Overwrite with changed config
		writeToml(dir, "svc.toml", UPDATED_TOML);

		const result = loadWorkloadsFromDir(db, dir);

		expect(result.loaded).toBe(0);
		expect(result.updated).toBe(1);
		expect(result.unchanged).toBe(0);
		expect(result.errors).toHaveLength(0);

		const row = db
			.select()
			.from(workloads)
			.where(
				and(
					eq(workloads.name, "test-service"),
					eq(workloads.version, "1.0.0"),
				),
			)
			.get();

		expect(row).toBeTruthy();
		expect(row!.config.resources.vcpus).toBe(4);
		expect(row!.config.resources.memory_mb).toBe(2048);
	});

	test("collects parse errors without aborting", () => {
		const dir = makeTempDir();
		writeToml(dir, "good.toml", VALID_TOML);
		writeToml(dir, "bad.toml", INVALID_TOML);

		const result = loadWorkloadsFromDir(db, dir);

		expect(result.loaded).toBe(1);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]!.file).toContain("bad.toml");
		expect(result.errors[0]!.error).toBeTruthy();
	});

	test("handles empty directory", () => {
		const dir = makeTempDir();

		const result = loadWorkloadsFromDir(db, dir);

		expect(result.loaded).toBe(0);
		expect(result.updated).toBe(0);
		expect(result.unchanged).toBe(0);
		expect(result.errors).toHaveLength(0);
	});

	test("handles nested .toml files", () => {
		const dir = makeTempDir();
		mkdirSync(join(dir, "sub"));
		writeToml(dir, "sub/nested.toml", VALID_TOML);

		const result = loadWorkloadsFromDir(db, dir);

		expect(result.loaded).toBe(1);
		expect(result.errors).toHaveLength(0);
	});

	test("preserves workloadId across updates", () => {
		const dir = makeTempDir();
		writeToml(dir, "svc.toml", VALID_TOML);

		loadWorkloadsFromDir(db, dir);

		const before = db
			.select()
			.from(workloads)
			.where(eq(workloads.name, "test-service"))
			.get();

		writeToml(dir, "svc.toml", UPDATED_TOML);
		loadWorkloadsFromDir(db, dir);

		const after = db
			.select()
			.from(workloads)
			.where(eq(workloads.name, "test-service"))
			.get();

		expect(after!.workloadId).toBe(before!.workloadId);
	});
});
