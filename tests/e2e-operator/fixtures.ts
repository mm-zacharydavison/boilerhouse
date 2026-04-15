import type {
	BoilerhouseWorkload,
	BoilerhouseClaim,
	BoilerhousePool,
	BoilerhouseTrigger,
} from "../../apps/operator/src/crd-types";

const API_VERSION = "boilerhouse.dev/v1alpha1" as const;
const NS = "boilerhouse";

// ── Workload fixtures ───────────────────────────────────────────────────────

export function httpserverWorkload(name: string): BoilerhouseWorkload {
	return {
		apiVersion: API_VERSION,
		kind: "BoilerhouseWorkload",
		metadata: { name, namespace: NS },
		spec: {
			version: "1",
			image: { ref: "busybox:1.36" },
			resources: { vcpus: 1, memoryMb: 128, diskGb: 1 },
			network: {
				access: "unrestricted",
				expose: [{ guest: 8080 }],
			},
			health: {
				intervalSeconds: 1,
				unhealthyThreshold: 3,
				httpGet: { path: "/", port: 8080 },
			},
			entrypoint: {
				cmd: "sh",
				args: ["-c", "mkdir -p /www && echo 'OK' > /www/index.html && busybox httpd -f -p 8080 -h /www"],
			},
		},
	};
}

export function minimalWorkload(name: string): BoilerhouseWorkload {
	return {
		apiVersion: API_VERSION,
		kind: "BoilerhouseWorkload",
		metadata: { name, namespace: NS },
		spec: {
			version: "1",
			image: { ref: "alpine:3.19" },
			resources: { vcpus: 1, memoryMb: 128, diskGb: 1 },
			network: { access: "none" },
			entrypoint: {
				cmd: "sh",
				args: ["-c", "while true; do sleep 3600; done"],
			},
		},
	};
}

export function overlayWorkload(name: string): BoilerhouseWorkload {
	return {
		apiVersion: API_VERSION,
		kind: "BoilerhouseWorkload",
		metadata: { name, namespace: NS },
		spec: {
			version: "1",
			image: { ref: "alpine:3.19" },
			resources: { vcpus: 1, memoryMb: 128, diskGb: 2 },
			network: { access: "none" },
			filesystem: {
				overlayDirs: ["/data"],
			},
			idle: {
				action: "hibernate",
			},
			entrypoint: {
				cmd: "sh",
				args: ["-c", "while true; do sleep 3600; done"],
			},
		},
	};
}

export function idleWorkload(name: string, timeoutSeconds: number): BoilerhouseWorkload {
	return {
		apiVersion: API_VERSION,
		kind: "BoilerhouseWorkload",
		metadata: { name, namespace: NS },
		spec: {
			version: "1",
			image: { ref: "alpine:3.19" },
			resources: { vcpus: 1, memoryMb: 128, diskGb: 1 },
			network: { access: "none" },
			filesystem: {
				overlayDirs: ["/data"],
			},
			idle: {
				timeoutSeconds,
				action: "hibernate",
			},
			entrypoint: {
				cmd: "sh",
				args: ["-c", "while true; do sleep 3600; done"],
			},
		},
	};
}

export function brokenWorkload(name: string): BoilerhouseWorkload {
	return {
		apiVersion: API_VERSION,
		kind: "BoilerhouseWorkload",
		metadata: { name, namespace: NS },
		spec: {
			version: "1",
			image: { ref: "docker.io/library/nonexistent-image:99.99.99" },
			resources: { vcpus: 1, memoryMb: 128, diskGb: 1 },
			network: { access: "none" },
			entrypoint: {
				cmd: "sh",
				args: ["-c", "exit 1"],
			},
		},
	};
}

export function openclawWorkload(name: string): BoilerhouseWorkload {
	return {
		apiVersion: API_VERSION,
		kind: "BoilerhouseWorkload",
		metadata: { name, namespace: NS },
		spec: {
			version: "1",
			image: { ref: "alpine:3.19" },
			resources: { vcpus: 1, memoryMb: 128, diskGb: 1 },
			network: {
				access: "restricted",
				allowlist: ["api.example.com"],
				credentials: [
					{
						domain: "api.example.com",
						secretRef: { name: "openclaw-creds", key: "token" },
						headers: { Authorization: "Bearer {{value}}" },
					},
				],
			},
			entrypoint: {
				cmd: "sh",
				args: ["-c", "while true; do sleep 3600; done"],
			},
		},
	};
}

// ── Other fixtures ──────────────────────────────────────────────────────────

export function claim(name: string, tenantId: string, workloadRef: string): BoilerhouseClaim {
	return {
		apiVersion: API_VERSION,
		kind: "BoilerhouseClaim",
		metadata: { name, namespace: NS },
		spec: {
			tenantId,
			workloadRef,
		},
	};
}

export function pool(name: string, workloadRef: string, size: number): BoilerhousePool {
	return {
		apiVersion: API_VERSION,
		kind: "BoilerhousePool",
		metadata: { name, namespace: NS },
		spec: {
			workloadRef,
			size,
		},
	};
}

export function trigger(
	name: string,
	workloadRef: string,
	type: "webhook" | "slack" | "telegram" | "cron",
	config?: Record<string, unknown>,
): BoilerhouseTrigger {
	return {
		apiVersion: API_VERSION,
		kind: "BoilerhouseTrigger",
		metadata: { name, namespace: NS },
		spec: {
			type,
			workloadRef,
			...(config ? { config } : {}),
		},
	};
}
