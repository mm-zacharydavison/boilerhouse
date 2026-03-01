import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { randomBytes } from "node:crypto";
import type { TenantId, Workload } from "@boilerhouse/core";
import { createTestDatabase } from "@boilerhouse/db";
import { ForwardProxy } from "./proxy/proxy";
import { SecretStore } from "./secret-store";
import { ProxyRegistrar } from "./proxy-registrar";

const WORKLOAD_WITH_TENANT_CREDS: Workload = {
	workload: { name: "test", version: "1.0.0" },
	image: { ref: "test:latest" },
	resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
	network: {
		access: "restricted",
		allowlist: ["api.anthropic.com"],
		credentials: [
			{
				domain: "api.anthropic.com",
				headers: { "x-api-key": "${tenant-secret:ANTHROPIC_API_KEY}" },
			},
		],
	},
	idle: { action: "hibernate" },
};

const WORKLOAD_WITH_GLOBAL_CREDS: Workload = {
	workload: { name: "test-global", version: "1.0.0" },
	image: { ref: "test:latest" },
	resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
	network: {
		access: "restricted",
		allowlist: ["api.anthropic.com"],
		credentials: [
			{
				domain: "api.anthropic.com",
				headers: { "x-api-key": "${global-secret:ANTHROPIC_API_KEY}" },
			},
		],
	},
	idle: { action: "hibernate" },
};

const WORKLOAD_NO_CREDS: Workload = {
	workload: { name: "test", version: "1.0.0" },
	image: { ref: "test:latest" },
	resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
	network: {
		access: "restricted",
		allowlist: ["api.openai.com"],
	},
	idle: { action: "hibernate" },
};

const TENANT_A = "tenant-aaa" as TenantId;

let proxy: ForwardProxy;
let secretStore: SecretStore;
let registrar: ProxyRegistrar;

beforeAll(async () => {
	const db = createTestDatabase();
	const key = randomBytes(32).toString("hex");
	secretStore = new SecretStore(db, key);
	proxy = new ForwardProxy({
		port: 0,
		secretResolver: (tenantId, template) =>
			secretStore.resolveSecretRefs(tenantId as TenantId, template),
	});
	await proxy.start();
	registrar = new ProxyRegistrar(proxy, secretStore);
});

afterAll(async () => {
	await proxy.stop();
});

describe("ProxyRegistrar", () => {
	test("registerInstance adds route with resolved tenant credentials", () => {
		secretStore.set(TENANT_A, "ANTHROPIC_API_KEY", "sk-test");
		registrar.registerInstance("10.88.0.2", WORKLOAD_WITH_TENANT_CREDS, TENANT_A);
		// No error = route registered
	});

	test("deregisterInstance removes route", () => {
		registrar.registerInstance("10.88.0.3", WORKLOAD_NO_CREDS, TENANT_A);
		registrar.deregisterInstance("10.88.0.3");
	});

	test("missing tenant-secret throws at registration time (fail-fast)", () => {
		expect(() =>
			registrar.registerInstance("10.88.0.4", WORKLOAD_WITH_TENANT_CREDS, "no-secrets-tenant" as TenantId),
		).toThrow(/ANTHROPIC_API_KEY/);
	});

	test("workload without credentials registers plain route", () => {
		registrar.registerInstance("10.88.0.5", WORKLOAD_NO_CREDS, TENANT_A);
	});

	test("golden boot with global-secret credentials succeeds", () => {
		const orig = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "sk-ant-platform";
		try {
			registrar.registerInstance("10.88.0.6", WORKLOAD_WITH_GLOBAL_CREDS, "" as TenantId);
		} finally {
			if (orig === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = orig;
		}
	});

	test("golden boot with tenant-secret credentials skips validation", () => {
		// No tenant secrets stored, but golden boot (empty tenantId) should not throw
		registrar.registerInstance("10.88.0.7", WORKLOAD_WITH_TENANT_CREDS, "" as TenantId);
	});
});
