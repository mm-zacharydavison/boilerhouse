import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { getTestClient, uniqueName, CrdTracker, CONTEXT, NAMESPACE, type KubeTestClient } from "./helpers";
import { httpserverWorkload, trigger } from "./fixtures";

describe("telegram-poll", () => {
	let client: KubeTestClient;
	const tracker = new CrdTracker();
	const secretName = uniqueName("tg-secret");
	let secretCreated = false;

	beforeAll(() => {
		client = getTestClient();
	});

	afterAll(async () => {
		await tracker.cleanup(client);
		if (secretCreated) {
			Bun.spawnSync([
				"kubectl", "--context", CONTEXT, "-n", NAMESPACE,
				"delete", "secret", secretName, "--ignore-not-found",
			]);
		}
	});

	test("create workload, create telegram trigger, verify it gets reconciled (status.phase appears)", async () => {
		// Create bot token secret
		const result = Bun.spawnSync([
			"kubectl", "--context", CONTEXT, "-n", NAMESPACE,
			"create", "secret", "generic", secretName,
			"--from-literal=bot-token=fake-telegram-bot-token",
		]);
		expect(result.exitCode).toBe(0);
		secretCreated = true;

		const wlName = uniqueName("wl");
		tracker.track("boilerhouseworkloads", wlName);
		await client.applyWorkload(httpserverWorkload(wlName));
		await client.waitForPhase("boilerhouseworkloads", wlName, "Ready");

		// Create telegram trigger
		const triggerName = uniqueName("trigger");
		tracker.track("boilerhousetriggers", triggerName);
		await client.applyTrigger(trigger(triggerName, wlName, "telegram", {
			botTokenSecret: { name: secretName, key: "bot-token" },
		}));

		// Wait for trigger to be reconciled (status.phase appears)
		const deadline = Date.now() + 60_000;
		let triggerStatus: Record<string, unknown> | undefined;
		while (Date.now() < deadline) {
			triggerStatus = await client.getStatus("boilerhousetriggers", triggerName);
			if (triggerStatus?.phase) break;
			await new Promise((r) => setTimeout(r, 1_000));
		}

		expect(triggerStatus).toBeDefined();
		expect(triggerStatus!.phase).toBeDefined();
		expect(typeof triggerStatus!.phase).toBe("string");
	}, 120_000);
});
