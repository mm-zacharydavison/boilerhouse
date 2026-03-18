import type { TriggerDefinition, TelegramConfig } from "../config";
import type { Dispatcher } from "../dispatcher";
import { DispatchError } from "../dispatcher";
import { resolveTenantId, TenantResolutionError } from "../resolve-tenant";

type TelegramTrigger = TriggerDefinition & { config: TelegramConfig };

/** Send a message via the Telegram Bot API. */
async function sendTelegramMessage(
	botToken: string,
	chatId: number,
	text: string,
): Promise<void> {
	await fetch(
		`https://api.telegram.org/bot${botToken}/sendMessage`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chat_id: chatId, text }),
		},
	);
}

/** Register webhook URLs with the Telegram Bot API. */
export async function registerTelegramWebhooks(
	triggers: TelegramTrigger[],
	baseUrl: string,
): Promise<void> {
	for (const trigger of triggers) {
		await fetch(
			`https://api.telegram.org/bot${trigger.config.botToken}/setWebhook`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					url: `${baseUrl}/telegram/${trigger.name}`,
					secret_token: trigger.config.secretToken,
					allowed_updates: trigger.config.updateTypes ?? ["message"],
				}),
			},
		);
	}
}

/** Create route handlers for Telegram triggers. One endpoint per trigger. */
export function createTelegramRoutes(
	triggers: TelegramTrigger[],
	dispatcher: Dispatcher,
): Record<string, (req: Request) => Promise<Response>> {
	const routes: Record<string, (req: Request) => Promise<Response>> = {};

	for (const trigger of triggers) {
		const path = `/telegram/${trigger.name}`;
		const { secretToken, updateTypes = ["message"] } = trigger.config;

		routes[path] = async (req: Request) => {
			if (req.method !== "POST") {
				return Response.json({ error: "Method not allowed" }, { status: 405 });
			}

			// Verify secret token
			if (secretToken) {
				const headerToken = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
				if (headerToken !== secretToken) {
					return Response.json({ error: "Invalid secret token" }, { status: 401 });
				}
			}

			let update: Record<string, unknown>;
			try {
				update = await req.json() as Record<string, unknown>;
			} catch {
				return Response.json({ error: "Invalid JSON" }, { status: 400 });
			}

			// Determine update type and filter
			const updateType = update.message
				? "message"
				: update.callback_query
					? "callback_query"
					: update.edited_message
						? "edited_message"
						: null;

			if (!updateType || !updateTypes.includes(updateType)) {
				return new Response(null, { status: 200 });
			}

			// Extract message text and chat ID
			const message = (update.message ?? update.edited_message) as
				| { text?: string; chat?: { id: number }; from?: { id: number } }
				| undefined;
			const callbackQuery = update.callback_query as
				| { data?: string; from?: { id: number }; message?: { chat?: { id: number } } }
				| undefined;

			const chatId = message?.chat?.id ?? callbackQuery?.message?.chat?.id;
			const userId = message?.from?.id ?? callbackQuery?.from?.id;
			const text = message?.text ?? callbackQuery?.data;

			// Resolve tenant from Telegram event context
			let tenantId: string;
			try {
				tenantId = resolveTenantId(trigger.tenant, {
					chatId,
					userId,
					text,
					updateType,
				});
			} catch (err) {
				if (err instanceof TenantResolutionError) {
					return Response.json({ error: err.message }, { status: 400 });
				}
				throw err;
			}

			try {
				const result = await dispatcher.dispatch({
					triggerName: trigger.name,
					tenantId,
					workload: trigger.workload,
					payload: {
						updateType,
						chatId,
						userId,
						text,
						update,
					},
				});

				// Send response back to chat
				if (chatId && result.agentResponse) {
					const responseText =
						typeof result.agentResponse === "string"
							? result.agentResponse
							: (result.agentResponse as Record<string, unknown>).text as string ??
								JSON.stringify(result.agentResponse);
					await sendTelegramMessage(trigger.config.botToken, chatId, responseText);
				}

				return new Response(null, { status: 200 });
			} catch (err) {
				if (err instanceof DispatchError) {
					return Response.json(
						{ error: err.message },
						{ status: err.statusCode },
					);
				}
				return Response.json({ error: "Internal error" }, { status: 500 });
			}
		};
	}

	return routes;
}
