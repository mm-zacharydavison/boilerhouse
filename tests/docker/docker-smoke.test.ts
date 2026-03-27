import { test, expect, describe, afterAll } from "bun:test";

const IMAGES = [
  { name: "api", dockerfile: "Dockerfile" },
  { name: "trigger-gateway", dockerfile: "Dockerfile.trigger-gateway" },
  { name: "dashboard", dockerfile: "Dockerfile.dashboard" },
] as const;

const TAG_PREFIX = "boilerhouse-smoke-test";

async function run(
  cmd: string[],
  opts?: { timeout?: number }
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    cwd: import.meta.dir + "/../..",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

describe("docker smoke tests", () => {
  const builtTags: string[] = [];
  const containers: string[] = [];

  afterAll(async () => {
    for (const c of containers) {
      await run(["docker", "rm", "-f", c]);
    }
    for (const tag of builtTags) {
      await run(["docker", "rmi", "-f", tag]);
    }
  });

  for (const image of IMAGES) {
    const tag = `${TAG_PREFIX}-${image.name}:test`;

    describe(image.name, () => {
      test(
        "builds successfully",
        async () => {
          const result = await run([
            "docker",
            "build",
            "-f",
            image.dockerfile,
            "-t",
            tag,
            ".",
          ]);
          if (result.exitCode !== 0) {
            console.error(
              `Build failed for ${image.name}:\n${result.stderr}\n${result.stdout}`
            );
          }
          expect(result.exitCode).toBe(0);
          builtTags.push(tag);
        },
        180_000
      );

      test(
        "binary is executable (no linker errors)",
        async () => {
          const containerName = `${TAG_PREFIX}-${image.name}-exec`;
          containers.push(containerName);
          await run(["docker", "rm", "-f", containerName]);

          // Start the container, let it run briefly, then check output
          const startResult = await run([
            "docker", "run", "-d",
            "--name", containerName,
            "-e", "NODE_ENV=production",
            tag,
          ]);
          expect(startResult.exitCode).toBe(0);

          await Bun.sleep(2000);

          const logs = await run(["docker", "logs", containerName]);
          const output = logs.stdout + logs.stderr;
          expect(output).not.toContain("no such file or directory");
          expect(output).not.toContain("rosetta error");
          expect(output).not.toContain("GLIBC_");
          expect(output).not.toContain("ld-musl");

          await run(["docker", "rm", "-f", containerName]);
        },
        15_000
      );

      test(
        "starts and stays running for 5s",
        async () => {
          const containerName = `${TAG_PREFIX}-${image.name}-run`;
          containers.push(containerName);

          // Clean up any leftover
          await run(["docker", "rm", "-f", containerName]);

          const env = [
            "-e", "LISTEN_HOST=0.0.0.0",
            "-e", "BOILERHOUSE_SECRET_KEY=0000000000000000000000000000000000000000000000000000000000000000",
            "-e", "DB_PATH=/tmp/test.db",
            "-e", "STORAGE_PATH=/tmp/data",
          ];

          if (image.name === "api") {
            env.push("-e", "RUNTIME_TYPE=fake");
          }
          if (image.name === "trigger-gateway") {
            // Create a minimal empty triggers config
            env.push("-e", "TRIGGERS_CONFIG=/dev/null");
          }

          const startResult = await run([
            "docker", "run", "-d",
            "--name", containerName,
            ...env,
            tag,
          ]);

          if (startResult.exitCode !== 0) {
            console.error(`Failed to start ${image.name}:\n${startResult.stderr}`);
          }
          expect(startResult.exitCode).toBe(0);

          // Wait for the process to either stabilize or crash
          await Bun.sleep(5000);

          const inspect = await run([
            "docker", "inspect",
            "--format", "{{.State.Status}}",
            containerName,
          ]);
          const status = inspect.stdout.trim();

          if (status !== "running") {
            const logs = await run(["docker", "logs", containerName]);
            console.error(
              `${image.name} exited (status: ${status}):\n${logs.stdout}\n${logs.stderr}`
            );
          }

          expect(status).toBe("running");
        },
        60_000
      );
    });
  }
});
