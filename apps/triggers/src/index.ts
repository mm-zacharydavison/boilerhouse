import type { TriggerConfig, WebhookConfig, SlackConfig, TelegramConfig, CronConfig } from "./config";
import { BoilerhouseClient } from "./client";
import { Dispatcher } from "./dispatcher";
import { createWebhookRoutes } from "./adapters/webhook";
import { createSlackRoutes } from "./adapters/slack";
import { createTelegramRoutes, registerTelegramWebhooks } from "./adapters/telegram";
import { CronAdapter } from "./adapters/cron";
import type { TriggerDefinition } from "./config";

const configPath = process.env.TRIGGERS_CONFIG ?? "./triggers.json";
const config = JSON.parse(await Bun.file(configPath).text()) as TriggerConfig;

const client = new BoilerhouseClient(config.boilerhouseApiUrl);
const dispatcher = new Dispatcher(client);

// Group triggers by type
const webhookTriggers = config.triggers.filter(
	(t): t is TriggerDefinition & { config: WebhookConfig } => t.type === "webhook",
);
const slackTriggers = config.triggers.filter(
	(t): t is TriggerDefinition & { config: SlackConfig } => t.type === "slack",
);
const telegramTriggers = config.triggers.filter(
	(t): t is TriggerDefinition & { config: TelegramConfig } => t.type === "telegram",
);
const cronTriggers = config.triggers.filter(
	(t): t is TriggerDefinition & { config: CronConfig } => t.type === "cron",
);

// Start cron timers
const cronAdapter = new CronAdapter();
cronAdapter.start(cronTriggers, dispatcher);

// Register Telegram webhooks with Telegram API
const publicUrl = process.env.TRIGGERS_PUBLIC_URL;
if (telegramTriggers.length > 0 && publicUrl) {
	await registerTelegramWebhooks(telegramTriggers, publicUrl);
}

// Build HTTP routes
const webhookRoutes = createWebhookRoutes(webhookTriggers, dispatcher);
const slackRoutes = createSlackRoutes(slackTriggers, dispatcher);
const telegramRoutes = createTelegramRoutes(telegramTriggers, dispatcher);

const port = config.port ?? 3001;

Bun.serve({
	port,
	routes: {
		...webhookRoutes,
		...slackRoutes,
		...telegramRoutes,
		"/healthz": () => new Response("ok"),
	},
});

console.log(
	`[triggers] listening on port ${port} | ${config.triggers.length} trigger(s) configured`,
);

// Graceful shutdown
process.on("SIGINT", () => {
	cronAdapter.stop();
	process.exit(0);
});
process.on("SIGTERM", () => {
	cronAdapter.stop();
	process.exit(0);
});
