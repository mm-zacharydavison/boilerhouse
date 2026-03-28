import type { TriggerPayload, TriggerDefinition } from "./config";

export interface GuardContext {
	tenantId: string;
	payload: TriggerPayload;
	trigger: TriggerDefinition;
	options: Record<string, unknown>;
}

export type GuardResult =
	| { ok: true }
	| { ok: false; message: string };

export interface Guard {
	check(ctx: GuardContext): Promise<GuardResult>;
}

/** A resolved guard paired with its options. */
export interface ResolvedGuardStep {
	guard: Guard;
	guardOptions: Record<string, unknown>;
}

/** Pre-resolved guard chains keyed by trigger name. Built at startup, passed to adapters. */
export type GuardMap = Map<string, ResolvedGuardStep[]>;
