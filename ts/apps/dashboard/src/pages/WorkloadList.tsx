import { useState, useCallback, useRef } from "react";
import { ChevronDown, ChevronRight, Trash2, UserPlus, Loader2, Plug, Moon } from "lucide-react";
import { useApi, useWebSocket } from "../hooks";
import {
	api,
	type WorkloadResponse,
	type InstanceResponse,
	type ClaimResponse,
	type SnapshotEntry,
} from "../api";
import {
	LoadingState,
	ErrorState,
	PageHeader,
	StatusIndicator,
	ConnectionModal,
} from "../components";

// --- Tree types ---

interface InstanceNode {
	instance: InstanceResponse;
}

interface WorkloadTreeNode {
	workload: WorkloadResponse;
	poolInstances: InstanceNode[];
	claimedInstances: InstanceNode[];
	/** Tenants with snapshots but no active claim (hibernated). */
	hibernatedTenants: SnapshotEntry[];
}

// --- Tree builder ---

function buildWorkloadTree(
	workloads: WorkloadResponse[],
	instances: InstanceResponse[],
	snapshots: SnapshotEntry[],
): WorkloadTreeNode[] {
	const instancesByWorkload = new Map<string, InstanceResponse[]>();
	for (const inst of instances) {
		if (inst.phase === "Succeeded" || inst.phase === "Failed") continue;
		const wlName = inst.workloadRef ?? "";
		const list = instancesByWorkload.get(wlName) ?? [];
		list.push(inst);
		instancesByWorkload.set(wlName, list);
	}

	// Group snapshots by workload
	const snapshotsByWorkload = new Map<string, SnapshotEntry[]>();
	for (const snap of snapshots) {
		const list = snapshotsByWorkload.get(snap.workloadRef) ?? [];
		list.push(snap);
		snapshotsByWorkload.set(snap.workloadRef, list);
	}

	return workloads.map((workload) => {
		const all = instancesByWorkload.get(workload.name) ?? [];
		const claimedInstances = all.filter((i) => !!i.tenantId);
		const activeTenantIds = new Set(claimedInstances.map((i) => i.tenantId!));

		// Hibernated = has snapshot but no active claim
		const allSnapshots = snapshotsByWorkload.get(workload.name) ?? [];
		const hibernatedTenants = allSnapshots.filter((s) => !activeTenantIds.has(s.tenantId));

		return {
			workload,
			poolInstances: all.filter((i) => !i.tenantId).map((inst) => ({ instance: inst })),
			claimedInstances: claimedInstances.map((inst) => ({ instance: inst })),
			hibernatedTenants,
		};
	});
}

// --- Formatting ---

function formatDate(dateStr: string): string {
	return new Date(dateStr).toLocaleDateString();
}

function shortId(id: string): string {
	return id;
}

// --- Icon Action Button ---

const ICON_VARIANTS: Record<string, string> = {
	danger: "text-status-red bg-status-red/10 border-status-red/20 hover:bg-status-red/20 active:bg-status-red/30",
	warning: "text-status-yellow bg-status-yellow/10 border-status-yellow/20 hover:bg-status-yellow/20 active:bg-status-yellow/30",
	info: "text-status-blue bg-status-blue/10 border-status-blue/20 hover:bg-status-blue/20 active:bg-status-blue/30",
};

function IconButton({
	icon: Icon,
	title,
	variant,
	onClick,
	disabled,
}: {
	icon: typeof Trash2;
	title: string;
	variant: "danger" | "warning" | "info";
	onClick: () => void;
	/** @default false */
	disabled?: boolean;
}) {
	return (
		<button
			title={title}
			disabled={disabled}
			onClick={(e) => {
				e.stopPropagation();
				onClick();
			}}
			className={`p-1 rounded border shadow-sm transition-colors ${ICON_VARIANTS[variant]} disabled:opacity-30 disabled:pointer-events-none disabled:shadow-none`}
		>
			<Icon size={13} />
		</button>
	);
}

// --- Claim Cell ---

function ClaimCell({ workloadName, disabled, onClaim }: { workloadName: string; disabled?: boolean; onClaim?: (source: string) => void }) {
	const [expanded, setExpanded] = useState(false);
	const [tenantId, setTenantId] = useState("");
	const [claiming, setClaiming] = useState(false);
	const [result, setResult] = useState<ClaimResponse | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function handleClaim() {
		if (!tenantId.trim()) return;
		setClaiming(true);
		setResult(null);
		setError(null);
		try {
			const res = await api.claimWorkload(tenantId.trim(), workloadName);
			setResult(res);
			onClaim?.(res.source ?? "unknown");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Claim failed");
		} finally {
			setClaiming(false);
		}
	}

	if (!expanded) {
		return (
			<IconButton
				icon={UserPlus}
				title="Claim workload"
				variant="info"
				disabled={disabled}
				onClick={() => setExpanded(true)}
			/>
		);
	}

	return (
		<div className="flex items-center gap-1">
			<input
				type="text"
				placeholder="tenant-id"
				value={tenantId}
				autoFocus
				onChange={(e) => setTenantId(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") handleClaim();
					if (e.key === "Escape") setExpanded(false);
				}}
				className="bg-surface-3 border border-border rounded px-2 py-0.5 text-xs font-mono text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-status-blue w-28"
			/>
			<IconButton
				icon={UserPlus}
				title={claiming ? "Claiming..." : "Claim"}
				variant="info"
				disabled={claiming || !tenantId.trim()}
				onClick={handleClaim}
			/>
			{error && (
				<span className="text-xs text-status-red truncate max-w-[140px]" title={error}>
					{error}
				</span>
			)}
			{result && (
				<span className="text-xs text-accent truncate">
					{result.source} {result.instanceId ? `-> ${shortId(result.instanceId)}` : ""}
				</span>
			)}
		</div>
	);
}

// --- Layout constants ---

/** Width of the chevron gutter (holds chevron in workload header, empty in other rows). */
const GUTTER_W = 24;
/** Width of the status icon column. */
const STATUS_W = 16;
/** Width of the date column (right-aligned). */
const DATE_W = 88;

// --- Instance Row ---

function InstanceRow({
	instance,
	onDestroy,
	onHibernate,
	onConnect,
	workloadName,
	busy,
	placeholder,
}: {
	instance?: InstanceResponse;
	onDestroy: (id: string) => void;
	onHibernate: (tenantId: string, workloadName: string) => void;
	onConnect: (instance: InstanceResponse) => void;
	workloadName: string;
	busy?: boolean;
	/** When true, renders a "warming..." placeholder row instead of real instance data. */
	placeholder?: boolean;
}) {
	if (placeholder) {
		return (
			<div className="flex items-center h-7 px-2 text-sm font-mono border-b border-border/10">
				<span style={{ width: GUTTER_W + STATUS_W }} className="shrink-0 flex items-center justify-end pr-2">
					<Loader2 size={10} className="text-muted animate-spin" />
				</span>
				<span className="text-muted text-xs">warming...</span>
			</div>
		);
	}

	if (!instance) return null;

	return (
		<div className="relative flex items-center h-7 px-2 text-sm font-mono border-b border-border/10 overflow-hidden">
			<span style={{ width: GUTTER_W + STATUS_W }} className="shrink-0 flex items-center justify-end pr-2">
				<StatusIndicator status={instance.phase} />
			</span>
			<a href={`#/instances/${instance.name}`} className="text-muted-light hover:text-status-blue hover:underline" title={instance.name}>
				{shortId(instance.name)}
			</a>
			{instance.tenantId && (
				<span className="text-xs font-mono ml-2 text-muted">
					for <span className="text-foreground">{instance.tenantId}</span>
				</span>
			)}
			{instance.ip && (
				<span className="text-xs font-mono ml-2 text-muted">
					{instance.ip}
				</span>
			)}

			<span className="flex-1" />

			{instance.phase !== "Succeeded" && instance.phase !== "Failed" && (
				busy ? (
					<Loader2 size={13} className="text-muted animate-spin mr-1" />
				) : (
					<div className="flex items-center gap-0.5">
						{instance.phase === "Running" && (
							<IconButton icon={Plug} title="Connect" variant="info" onClick={() => onConnect(instance)} />
						)}
						{instance.tenantId && instance.phase === "Running" && (
							<IconButton icon={Moon} title="Hibernate" variant="warning" onClick={() => onHibernate(instance.tenantId!, workloadName)} />
						)}
						<IconButton icon={Trash2} title="Destroy" variant="danger" onClick={() => onDestroy(instance.name)} />
					</div>
				)
			)}

			<span style={{ width: DATE_W }} className="shrink-0 text-muted text-xs tabular-nums text-right">
				{formatDate(instance.createdAt)}
			</span>
		</div>
	);
}

// --- Instance Section ---

function InstanceSection({
	label,
	instances,
	onDestroy,
	onHibernate,
	onConnect,
	workloadName,
	busyInstances,
	pendingWarm,
}: {
	label: string;
	instances: InstanceNode[];
	onDestroy: (id: string) => void;
	onHibernate: (tenantId: string, workloadName: string) => void;
	onConnect: (instance: InstanceResponse) => void;
	workloadName: string;
	busyInstances: Set<string>;
	pendingWarm?: boolean;
}) {
	return (
		<>
			<div
				className="flex items-center h-6 px-2 border-b border-border/10"
				style={{ paddingLeft: GUTTER_W + STATUS_W + 8 }}
			>
				<span className="text-xs text-muted font-mono uppercase tracking-wider">{label}</span>
				<span className="text-xs text-muted font-mono ml-1.5">({instances.length})</span>
			</div>
			{instances.map((inst) => (
				<InstanceRow
					key={inst.instance.name}
					instance={inst.instance}
					onDestroy={onDestroy}
					onHibernate={onHibernate}
					onConnect={onConnect}
					workloadName={workloadName}
					busy={busyInstances.has(inst.instance.name)}
				/>
			))}
			{pendingWarm && (
				<InstanceRow
					key="pending-warm"
					placeholder
					onDestroy={onDestroy}
					onHibernate={onHibernate}
					onConnect={onConnect}
					workloadName={workloadName}
				/>
			)}
		</>
	);
}

// --- Workload Group ---

function WorkloadGroup({
	node,
	expanded,
	onToggle,
	onDestroy,
	onHibernate,
	onConnect,
	navigate,
	busyInstances,
	busyTenants,
	onClaim,
	onRevive,
	pendingWarm,
}: {
	node: WorkloadTreeNode;
	expanded: boolean;
	onToggle: () => void;
	onDestroy: (id: string) => void;
	onHibernate: (tenantId: string, workloadName: string) => void;
	onRevive: (tenantId: string, workloadName: string) => void;
	onConnect: (instance: InstanceResponse) => void;
	navigate: (path: string) => void;
	busyInstances: Set<string>;
	busyTenants: Set<string>;
	onClaim?: (workloadName: string, source: string) => void;
	pendingWarm?: boolean;
}) {
	const { workload, poolInstances, claimedInstances, hibernatedTenants } = node;
	const Chevron = expanded ? ChevronDown : ChevronRight;
	const hasInstances = poolInstances.length > 0 || claimedInstances.length > 0 || hibernatedTenants.length > 0 || !!pendingWarm;
	const phase = workload.status.phase ?? "Unknown";

	return (
		<div className="mb-3">
			{/* Workload header */}
			<div className="flex items-center h-8 px-2 bg-surface-1 rounded">
				<span style={{ width: GUTTER_W }} className="shrink-0 flex items-center justify-center">
					<button
						onClick={onToggle}
						className="text-muted hover:text-white transition-colors"
					>
						<Chevron size={14} />
					</button>
				</span>
				<span style={{ width: STATUS_W }} className="shrink-0 flex items-center">
					<StatusIndicator status={phase} detail={workload.status.detail ?? undefined} />
				</span>
				<a
					href={`#/workloads/${workload.name}`}
					onClick={(e) => {
						e.preventDefault();
						navigate(`/workloads/${workload.name}`);
					}}
					className="font-mono font-medium text-accent hover:text-accent-bright transition-colors"
				>
					{workload.name}
				</a>
				<span className="text-muted-light text-xs font-mono ml-2">v{workload.spec.version}</span>
				{phase !== "Ready" && (
					<span className="text-xs text-muted font-mono ml-2">({phase})</span>
				)}

				<span className="flex-1" />

				<div onClick={(e) => e.stopPropagation()}>
					<ClaimCell workloadName={workload.name} disabled={phase !== "Ready"} onClaim={(source) => onClaim?.(workload.name, source)} />
				</div>
			</div>

			{/* Expanded children */}
			{expanded && hasInstances && (
				<div className="mt-1">
					{(poolInstances.length > 0 || pendingWarm) && (
						<>
							<InstanceSection
								label="pool"
								instances={poolInstances}
								onDestroy={onDestroy}
								onHibernate={onHibernate}
								onConnect={onConnect}
								workloadName={workload.name}
								busyInstances={busyInstances}
								pendingWarm={pendingWarm}
							/>
						</>
					)}
					{claimedInstances.length > 0 && (
						<InstanceSection
							label="claimed"
							instances={claimedInstances}
							onDestroy={onDestroy}
							onHibernate={onHibernate}
							onConnect={onConnect}
							workloadName={workload.name}
							busyInstances={busyInstances}
						/>
					)}
					{hibernatedTenants.length > 0 && (
						<>
							<div
								className="flex items-center h-6 px-2 border-b border-border/10"
								style={{ paddingLeft: GUTTER_W + STATUS_W + 8 }}
							>
								<span className="text-xs text-muted font-mono uppercase tracking-wider">hibernated</span>
								<span className="text-xs text-muted font-mono ml-1.5">({hibernatedTenants.length})</span>
							</div>
							{hibernatedTenants.map((snap) => {
								const busy = busyTenants.has(`${snap.tenantId}:${workload.name}`);
								return (
									<div key={snap.tenantId} className="flex items-center h-7 px-2 text-sm font-mono border-b border-border/10">
										<span style={{ width: GUTTER_W + STATUS_W }} className="shrink-0 flex items-center justify-end pr-2">
											{busy
												? <Loader2 size={10} className="text-muted animate-spin" />
												: <span className="font-mono text-sm leading-none text-status-blue cursor-default" title="hibernated">◑</span>
											}
										</span>
										<span className="text-muted-light">{snap.tenantId}</span>
										<span className="flex-1" />
										{busy
											? <Loader2 size={13} className="text-muted animate-spin mr-1" />
											: <IconButton
												icon={UserPlus}
												title="Revive (claim with snapshot)"
												variant="info"
												onClick={() => onRevive(snap.tenantId, workload.name)}
											/>
										}
									</div>
								);
							})}
						</>
					)}
				</div>
			)}
		</div>
	);
}

// --- Main Component ---

export function WorkloadList({ navigate }: { navigate: (path: string) => void }) {
	const workloadsApi = useApi<WorkloadResponse[]>(api.fetchWorkloads);
	const instancesApi = useApi<InstanceResponse[]>(useCallback(() => api.fetchInstances(), []));
	const snapshotsApi = useApi<SnapshotEntry[]>(api.fetchSnapshots);

	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [initialized, setInitialized] = useState(false);
	const [busyInstances, setBusyInstances] = useState<Set<string>>(new Set());
	const [pendingWarms, setPendingWarms] = useState<Set<string>>(new Set());
	const [connectTarget, setConnectTarget] = useState<{ instance: InstanceResponse; workloadName: string } | null>(null);
	const [busyTenants, setBusyTenants] = useState<Set<string>>(new Set());

	// Auto-refresh when instance state changes (debounced to avoid flicker)
	const { refetch: refetchWorkloads } = workloadsApi;
	const { refetch: refetchInstances } = instancesApi;
	const { refetch: refetchSnapshots } = snapshotsApi;
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	useWebSocket(useCallback((event) => {
		const e = event as { type: string; workloadRef?: string; tenantId?: string | null };
		if (e.type === "instance.state" || e.type === "tenant.released" || e.type === "tenant.claimed" || e.type === "pool.instance.ready") {
			if (e.type === "instance.state" && !e.tenantId && e.workloadRef) {
				setPendingWarms((prev) => {
					if (!prev.has(e.workloadRef!)) return prev;
					const next = new Set(prev);
					next.delete(e.workloadRef!);
					return next;
				});
			}
			// Debounce: batch rapid events into a single refetch
			if (debounceRef.current) clearTimeout(debounceRef.current);
			debounceRef.current = setTimeout(() => {
				refetchWorkloads();
				refetchInstances();
				refetchSnapshots();
			}, 200);
		}
	}, [refetchWorkloads, refetchInstances]));

	const loading = workloadsApi.loading || instancesApi.loading;
	const error = workloadsApi.error || instancesApi.error;

	// Expand all workloads by default once data loads
	if (!initialized && workloadsApi.data) {
		setExpanded(new Set(workloadsApi.data.map((w) => w.name)));
		setInitialized(true);
	}

	if (loading) return <LoadingState />;
	if (error) return <ErrorState message={error} />;
	if (!workloadsApi.data) return null;

	const tree = buildWorkloadTree(
		workloadsApi.data,
		instancesApi.data ?? [],
		snapshotsApi.data ?? [],
	);

	function toggleExpanded(workloadName: string) {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(workloadName)) next.delete(workloadName);
			else next.add(workloadName);
			return next;
		});
	}

	function refetchAll() {
		workloadsApi.refetch();
		instancesApi.refetch();
		snapshotsApi.refetch();
	}

	function handleClaim(workloadName: string, source: string) {
		if (source === "pool" || source === "pool+data") {
			setPendingWarms((prev) => new Set(prev).add(workloadName));
		}
		refetchAll();
	}

	async function handleHibernate(tenantId: string, workloadName: string) {
		const tenantKey = `${tenantId}:${workloadName}`;
		setBusyTenants((prev) => new Set(prev).add(tenantKey));
		try {
			await api.releaseWorkload(tenantId, workloadName);
			refetchAll();
		} catch (err) {
			alert(err instanceof Error ? err.message : "Hibernate failed");
		} finally {
			setBusyTenants((prev) => { const next = new Set(prev); next.delete(tenantKey); return next; });
		}
	}

	async function handleRevive(tenantId: string, workloadName: string) {
		const key = `${tenantId}:${workloadName}`;
		setBusyTenants((prev) => new Set(prev).add(key));
		try {
			const res = await api.claimWorkload(tenantId, workloadName);
			// A pool pod was consumed — show warming placeholder for the replacement.
			if (res.source === "pool" || res.source === "pool+data") {
				setPendingWarms((prev) => new Set(prev).add(workloadName));
			}
			refetchAll();
		} catch (err) {
			alert(err instanceof Error ? err.message : "Revive failed");
		} finally {
			setBusyTenants((prev) => { const next = new Set(prev); next.delete(key); return next; });
		}
	}

	async function handleDestroy(instanceName: string) {
		setBusyInstances((prev) => new Set(prev).add(instanceName));
		try {
			await api.destroyInstance(instanceName);
			refetchAll();
		} catch (err) {
			alert(err instanceof Error ? err.message : "Destroy failed");
		} finally {
			setBusyInstances((prev) => {
				const next = new Set(prev);
				next.delete(instanceName);
				return next;
			});
		}
	}

	return (
		<div>
			<PageHeader>workloads</PageHeader>
			{tree.length === 0 ? (
				<p className="text-muted font-mono text-sm">no workloads registered.</p>
			) : (
				<div>
					{tree.map((node) => (
						<WorkloadGroup
							key={node.workload.name}
							node={node}
							expanded={expanded.has(node.workload.name)}
							onToggle={() => toggleExpanded(node.workload.name)}
							onDestroy={handleDestroy}
							onHibernate={handleHibernate}
							onConnect={(instance) => setConnectTarget({ instance, workloadName: node.workload.name })}
							navigate={navigate}
							busyInstances={busyInstances}
							busyTenants={busyTenants}
							onClaim={handleClaim}
							onRevive={handleRevive}
							pendingWarm={pendingWarms.has(node.workload.name)}
						/>
					))}
				</div>
			)}

			{connectTarget && (
				<ConnectionModal
					instance={connectTarget.instance}
					workloadName={connectTarget.workloadName}
					onClose={() => setConnectTarget(null)}
				/>
			)}
		</div>
	);
}
