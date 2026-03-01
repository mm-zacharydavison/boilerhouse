import { describe, test, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { createTestApp, apiRequest } from "../test-helpers";
import { SecretStore } from "../secret-store";

function setup() {
	const ctx = createTestApp();
	const key = randomBytes(32).toString("hex");
	const secretStore = new SecretStore(ctx.db, key);
	// Rebuild app with secretStore in deps
	const { createApp } = require("../app");
	const app = createApp({ ...ctx, secretStore });
	return { app, secretStore, db: ctx.db };
}

describe("secret routes", () => {
	test("PUT /tenants/:id/secrets/:name sets a secret (201)", async () => {
		const { app } = setup();
		const res = await apiRequest(app, "/api/v1/tenants/t-1/secrets/API_KEY", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ value: "sk-test-12345" }),
		});
		expect(res.status).toBe(201);
	});

	test("GET /tenants/:id/secrets lists names without values", async () => {
		const { app, secretStore } = setup();
		secretStore.set("t-1" as any, "KEY_A", "val-a");
		secretStore.set("t-1" as any, "KEY_B", "val-b");

		const res = await apiRequest(app, "/api/v1/tenants/t-1/secrets");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { secrets: string[] };
		expect(body.secrets).toEqual(["KEY_A", "KEY_B"]);
	});

	test("DELETE /tenants/:id/secrets/:name removes a secret", async () => {
		const { app, secretStore } = setup();
		secretStore.set("t-1" as any, "API_KEY", "value");

		const res = await apiRequest(app, "/api/v1/tenants/t-1/secrets/API_KEY", {
			method: "DELETE",
		});
		expect(res.status).toBe(200);
		expect(secretStore.get("t-1" as any, "API_KEY")).toBeNull();
	});

	test("PUT without secretStore returns 501", async () => {
		const ctx = createTestApp();
		const res = await apiRequest(ctx.app, "/api/v1/tenants/t-1/secrets/KEY", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ value: "val" }),
		});
		expect(res.status).toBe(501);
	});
});
