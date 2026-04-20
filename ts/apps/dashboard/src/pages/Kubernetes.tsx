import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { api, type DebugResourceEntry, type DebugResourcesResponse } from "../api";
import { useApi, useAutoRefresh } from "../hooks";
import { JsonSyntax } from "../json-syntax";

type KindKey =
	| "workloads"
	| "pools"
	| "claims"
	| "triggers"
	| "pods"
	| "persistentVolumeClaims"
	| "services"
	| "networkPolicies";

interface KindDef {
	key: KindKey;
	label: string;
	columns: { title: string; render: (e: DebugResourceEntry) => React.ReactNode }[];
}

function cell(value: unknown): string {
	if (value === null || value === undefined || value === "") return "-";
	return String(value);
}

const KINDS: KindDef[] = [
	{
		key: "workloads",
		label: "Workloads",
		columns: [
			{ title: "name", render: (e) => e.name },
			{ title: "phase", render: (e) => cell(e.phase) },
			{ title: "image", render: (e) => cell(e.summary.image) },
			{ title: "age", render: (e) => cell(e.age) },
		],
	},
	{
		key: "pools",
		label: "Pools",
		columns: [
			{ title: "name", render: (e) => e.name },
			{ title: "phase", render: (e) => cell(e.phase) },
			{
				title: "size",
				render: (e) => `${cell(e.summary.ready)}/${cell(e.summary.desired)}`,
			},
			{ title: "age", render: (e) => cell(e.age) },
		],
	},
	{
		key: "claims",
		label: "Claims",
		columns: [
			{ title: "name", render: (e) => e.name },
			{ title: "phase", render: (e) => cell(e.phase) },
			{ title: "tenant", render: (e) => cell(e.summary.tenant) },
			{ title: "instance", render: (e) => cell(e.summary.instance) },
			{ title: "age", render: (e) => cell(e.age) },
		],
	},
	{
		key: "triggers",
		label: "Triggers",
		columns: [
			{ title: "name", render: (e) => e.name },
			{ title: "phase", render: (e) => cell(e.phase) },
			{ title: "type", render: (e) => cell(e.summary.type) },
			{ title: "workload", render: (e) => cell(e.summary.workloadRef) },
			{ title: "age", render: (e) => cell(e.age) },
		],
	},
	{
		key: "pods",
		label: "Pods",
		columns: [
			{ title: "name", render: (e) => e.name },
			{ title: "phase", render: (e) => cell(e.phase) },
			{ title: "node", render: (e) => cell(e.summary.node) },
			{ title: "podIP", render: (e) => cell(e.summary.podIP) },
			{ title: "age", render: (e) => cell(e.age) },
		],
	},
	{
		key: "persistentVolumeClaims",
		label: "PersistentVolumeClaims",
		columns: [
			{ title: "name", render: (e) => e.name },
			{ title: "phase", render: (e) => cell(e.phase) },
			{ title: "storageClass", render: (e) => cell(e.summary.storageClass) },
			{ title: "capacity", render: (e) => cell(e.summary.capacity) },
			{ title: "age", render: (e) => cell(e.age) },
		],
	},
	{
		key: "services",
		label: "Services",
		columns: [
			{ title: "name", render: (e) => e.name },
			{ title: "type", render: (e) => cell(e.summary.type) },
			{ title: "clusterIP", render: (e) => cell(e.summary.clusterIP) },
			{ title: "ports", render: (e) => cell(e.summary.ports) },
			{ title: "age", render: (e) => cell(e.age) },
		],
	},
	{
		key: "networkPolicies",
		label: "NetworkPolicies",
		columns: [
			{ title: "name", render: (e) => e.name },
			{ title: "podSelector", render: (e) => cell(e.summary.podSelector) },
			{ title: "age", render: (e) => cell(e.age) },
		],
	},
];

function Section({ def, entries }: { def: KindDef; entries: DebugResourceEntry[] }) {
	const [collapsed, setCollapsed] = useState(false);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());

	function toggleRow(name: string) {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(name)) next.delete(name);
			else next.add(name);
			return next;
		});
	}

	return (
		<section className="mb-6">
			<button
				type="button"
				onClick={() => setCollapsed((c) => !c)}
				className="flex items-center gap-2 px-2 py-1 font-tight font-semibold text-white hover:bg-surface-3/50 rounded w-full text-left"
			>
				<span className="text-muted font-mono text-sm">{collapsed ? "▸" : "▾"}</span>
				<span>{def.label}</span>
				<span className="text-muted font-mono text-sm">({entries.length})</span>
			</button>
			{!collapsed && (
				<div className="mt-1 border border-border/20 rounded overflow-hidden">
					{entries.length === 0 ? (
						<div className="px-3 py-2 text-muted font-mono text-sm">no resources</div>
					) : (
						<table className="w-full text-sm font-mono">
							<thead className="bg-surface-2 text-muted-light">
								<tr>
									{def.columns.map((c) => (
										<th key={c.title} className="px-2 py-1 text-left font-normal">
											{c.title}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{entries.map((e) => {
									const isOpen = expanded.has(e.name);
									return (
										<Fragment key={e.name}>
											<tr
												onClick={() => toggleRow(e.name)}
												className="border-t border-border/10 cursor-pointer hover:bg-surface-2"
											>
												{def.columns.map((c) => (
													<td key={c.title} className="px-2 py-1">
														{c.render(e)}
													</td>
												))}
											</tr>
											{isOpen && (
												<tr className="bg-surface-1">
													<td colSpan={def.columns.length} className="p-2">
														<JsonSyntax data={e.raw} />
													</td>
												</tr>
											)}
										</Fragment>
									);
								})}
							</tbody>
						</table>
					)}
				</div>
			)}
		</section>
	);
}

export function Kubernetes() {
	const { data, loading, error, refetch } = useApi<DebugResourcesResponse>(api.fetchDebugResources);
	const { setPaused } = useAutoRefresh(refetch, 3000);

	// Pause polling while the tab is hidden.
	useEffect(() => {
		const onVis = () => setPaused(document.visibilityState !== "visible");
		onVis();
		document.addEventListener("visibilitychange", onVis);
		return () => document.removeEventListener("visibilitychange", onVis);
	}, [setPaused]);

	const lastRefreshed = useRef<number>(Date.now());
	useEffect(() => {
		if (data) lastRefreshed.current = Date.now();
	}, [data]);

	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		const t = window.setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, []);
	const secondsAgo = Math.max(0, Math.floor((now - lastRefreshed.current) / 1000));

	const sections = useMemo(() => {
		if (!data) return null;
		return KINDS.map((def) => (
			<Section key={def.key} def={def} entries={data[def.key]} />
		));
	}, [data]);

	return (
		<div>
			<div className="flex items-baseline justify-between mb-4">
				<h1 className="text-xl font-tight font-bold text-white">kubernetes</h1>
				<div className="flex items-center gap-3 text-sm font-mono text-muted">
					<span>{loading && !data ? "loading…" : `refreshed ${secondsAgo}s ago`}</span>
					<button
						type="button"
						onClick={() => refetch()}
						className="px-2 py-0.5 border border-border/30 rounded hover:bg-surface-2 text-muted-light"
					>
						refresh
					</button>
				</div>
			</div>

			{error && (
				<div className="mb-4 px-3 py-2 border border-status-red/30 bg-status-red/10 text-status-red font-mono text-sm rounded">
					{error}
				</div>
			)}

			{sections}
		</div>
	);
}
