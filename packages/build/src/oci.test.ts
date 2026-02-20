import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { pullImage, exportFilesystem, buildImage } from "./oci";
import { OciError } from "./errors";

const INTEGRATION = process.env.BOILERHOUSE_INTEGRATION === "1";

describe.skipIf(!INTEGRATION)("oci", () => {
	let workDir: string;

	beforeAll(() => {
		workDir = mkdtempSync(join(tmpdir(), "boilerhouse-oci-"));
	});

	afterAll(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	test("pulls a public OCI image", async () => {
		await pullImage("alpine:latest");
	}, 60_000);

	test("exports the filesystem to a tarball", async () => {
		const tarPath = join(workDir, "alpine.tar");
		await exportFilesystem("alpine:latest", tarPath);
		expect(existsSync(tarPath)).toBe(true);

		// Verify tarball contains expected directories
		const proc = Bun.spawn(["tar", "tf", tarPath], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;

		expect(stdout).toContain("bin/");
		expect(stdout).toContain("etc/");
		expect(stdout).toContain("usr/");
	}, 60_000);

	test("handles Dockerfile build", async () => {
		const dockerfilePath = join(workDir, "Dockerfile");
		await Bun.write(dockerfilePath, "FROM alpine:latest\nRUN echo hello > /hello.txt\n");

		const tarPath = join(workDir, "dockerfile-build.tar");
		await buildImage(dockerfilePath, tarPath);
		expect(existsSync(tarPath)).toBe(true);

		// Verify the built content is in the tarball
		const proc = Bun.spawn(["tar", "tf", tarPath], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;

		expect(stdout).toContain("hello.txt");
	}, 120_000);

	test("rejects invalid image refs", async () => {
		await expect(pullImage("invalid-registry.example.com/nonexistent:99999"))
			.rejects.toBeInstanceOf(OciError);
	}, 30_000);
});
