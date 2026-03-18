import { test, expect, beforeAll, afterAll } from "bun:test";
import { Cron } from "croner";
import { CronAdapter } from "./cron";
import { Dispatcher } from "../dispatcher";
import type { DispatcherDeps } from "../dispatcher";
import type { TriggerDefinition, CronConfig } from "../config";

// --- croner sanity checks ---

test("croner parses standard 5-field expressions", () => {
	const job = new Cron("*/5 * * * *");
	const next = job.nextRun();
	expect(next).toBeInstanceOf(Date);
	expect(next!.getTime()).toBeGreaterThan(Date.now());
});

test("croner rejects invalid expressions", () => {
	expect(() => new Cron("bad")).toThrow();
});

test("croner handles day-of-week and month fields", () => {
	// Every Monday at 9:00
	const job = new Cron("0 9 * * 1");
	const next = job.nextRun();
	expect(next).toBeInstanceOf(Date);
	expect(next!.getDay()).toBe(1);
});

// --- CronAdapter tests ---

let agentServer: ReturnType<typeof Bun.serve>;

function createTestDeps(): DispatcherDeps {
	return {
		async claim(tenantId) {
			return {
				tenantId,
				instanceId: "i-1",
				endpoint: { host: "localhost", ports: [agentServer.port!] },
				source: "warm",
				latencyMs: 10,
			};
		},
		logActivity() {},
	};
}

beforeAll(() => {
	agentServer = Bun.serve({
		port: 0,
		async fetch() {
			return Response.json({ reply: "cron ok" });
		},
	});
});

afterAll(() => {
	agentServer.stop(true);
});

function makeCronTrigger(schedule: string): TriggerDefinition & { config: CronConfig } {
	return {
		name: "cron-test",
		type: "cron",
		tenant: { static: "reporting" },
		workload: "w-1",
		config: {
			schedule,
			payload: { type: "scheduled" },
		},
	};
}

test("CronAdapter starts and can be stopped", () => {
	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const adapter = new CronAdapter();

	adapter.start([makeCronTrigger("*/1 * * * *")], dispatcher);
	adapter.stop();
});

test("CronAdapter stop clears all jobs", () => {
	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const adapter = new CronAdapter();

	adapter.start(
		[
			makeCronTrigger("*/5 * * * *"),
			{ ...makeCronTrigger("0 * * * *"), name: "cron-2" },
		],
		dispatcher,
	);

	adapter.stop();

	// Verify stop is idempotent
	adapter.stop();
});

test("CronAdapter rejects invalid cron expressions", () => {
	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const adapter = new CronAdapter();

	expect(() => adapter.start([makeCronTrigger("not valid")], dispatcher)).toThrow();
});
