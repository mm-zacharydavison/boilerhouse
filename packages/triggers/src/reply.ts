/**
 * Serializable reply context — stored in BullMQ job data so the worker
 * can send the agent's response back to the originating service after
 * dispatch completes.
 *
 * Secrets (bot tokens) are NOT stored here. The worker resolves them
 * from the trigger config at send time via `triggerName`.
 */

import { sendTelegramMessage } from "./adapters/telegram-parse";
import { postSlackMessage } from "./adapters/slack";
import type { TriggerDefinition, TelegramPollConfig, SlackConfig } from "./config";

export type ReplyContext =
	| { adapter: "telegram"; chatId: number; apiBaseUrl?: string }
	| { adapter: "slack"; channelId: string }
	| { adapter: "webhook" }
	| { adapter: "cron" };

/**
 * Send an agent response back to the originating service.
 *
 * Looks up secrets from the trigger definition — only addressing info
 * (chatId, channelId) comes from the serialized ReplyContext.
 */
export async function sendReply(
	ctx: ReplyContext,
	agentResponse: unknown,
	triggerDef: TriggerDefinition,
): Promise<void> {
	const text =
		typeof agentResponse === "string"
			? agentResponse
			: (agentResponse as Record<string, unknown>)?.text as string ??
				JSON.stringify(agentResponse);

	switch (ctx.adapter) {
		case "telegram": {
			const config = triggerDef.config as TelegramPollConfig;
			await sendTelegramMessage(
				config.botToken,
				ctx.chatId,
				text,
				ctx.apiBaseUrl ?? config.apiBaseUrl,
			);
			break;
		}
		case "slack": {
			const config = triggerDef.config as SlackConfig;
			await postSlackMessage(config.botToken, ctx.channelId, text);
			break;
		}
		case "webhook":
		case "cron":
			// No async reply — webhook returns inline, cron is fire-and-forget
			break;
	}
}
