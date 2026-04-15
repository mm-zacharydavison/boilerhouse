import { useCallback, useEffect, useRef } from "react";
import { useApi } from "../hooks";
import { api, type TriggerResponse } from "../api";
import {
	LoadingState,
	ErrorState,
	PageHeader,
	DataTable,
	DataRow,
	ActionButton,
	StatusIndicator,
} from "../components";

const TYPE_COLORS: Record<string, string> = {
	webhook: "text-status-blue bg-status-blue/10 border-status-blue/20",
	slack: "text-status-green bg-status-green/10 border-status-green/20",
	telegram: "text-accent bg-accent/10 border-accent/20",
	cron: "text-status-yellow bg-status-yellow/10 border-status-yellow/20",
};

function TypeBadge({ type }: { type: string }) {
	const cls = TYPE_COLORS[type] ?? "text-muted bg-surface-3 border-border/30";
	return (
		<span className={`px-1.5 py-0.5 text-xs font-mono rounded border ${cls}`}>
			{type}
		</span>
	);
}

function formatTenant(tenant?: { static?: string; from?: string; prefix?: string }): string {
	if (!tenant) return "-";
	if (tenant.static) return tenant.static;
	const prefix = tenant.prefix ?? "";
	return `${prefix}{${tenant.from ?? "?"}}`;
}

// --- Trigger List ---

export function TriggerList({ tick }: { tick?: number }) {
	const { data, loading, error, refetch } = useApi<TriggerResponse[]>(api.fetchTriggers);

	// Refetch when tick changes (WS events) without remounting.
	const initialTick = useRef(tick);
	useEffect(() => {
		if (tick !== initialTick.current) refetch();
	}, [tick, refetch]);

	const handleDelete = useCallback(
		async (trigger: TriggerResponse) => {
			if (!confirm(`Delete trigger "${trigger.name}"?`)) return;
			try {
				await api.deleteTrigger(trigger.name);
				refetch();
			} catch (err) {
				console.error("Failed to delete trigger:", err);
			}
		},
		[refetch],
	);

	if (loading && !data) return <LoadingState />;
	if (error && !data) return <ErrorState message={error} />;
	if (!data) return null;

	return (
		<div>
			<div className="flex items-center justify-between mb-6">
				<PageHeader>triggers</PageHeader>
			</div>

			{data.length === 0 ? (
				<p className="text-muted font-mono text-sm">no triggers configured.</p>
			) : (
				<DataTable headers={["Name", "Type", "Workload", "Tenant", "Driver", "Guards", "Phase", "Created", "Actions"]}>
					{data.map((t) => (
						<DataRow key={t.name}>
							<td className="px-4 py-3 text-gray-200">{t.name}</td>
							<td className="px-4 py-3">
								<TypeBadge type={t.spec.type} />
							</td>
							<td className="px-4 py-3 text-muted-light">{t.spec.workloadRef}</td>
							<td className="px-4 py-3 text-muted-light font-mono text-xs">
								{formatTenant(t.spec.tenant)}
							</td>
							<td className="px-4 py-3 text-muted font-mono text-xs">
								{t.spec.driver || <span className="text-muted/50">default</span>}
							</td>
							<td className="px-4 py-3">
								{t.spec.guards && t.spec.guards.length > 0 ? (
									<div className="flex flex-wrap gap-1">
										{t.spec.guards.map((g, i) => (
											<span
												key={i}
												className="px-1.5 py-0.5 text-xs font-mono rounded border text-status-yellow bg-status-yellow/10 border-status-yellow/20"
											>
												{g.type ?? "guard"}
											</span>
										))}
									</div>
								) : (
									<span className="text-muted/50 font-mono text-xs">none</span>
								)}
							</td>
							<td className="px-4 py-3">
								<StatusIndicator
									status={t.status.phase ?? "Unknown"}
									detail={t.status.detail ?? undefined}
								/>
							</td>
							<td className="px-4 py-3 text-muted text-xs">
								{new Date(t.createdAt).toLocaleDateString()}
							</td>
							<td className="px-4 py-3">
								<div className="flex gap-2">
									<ActionButton
										label="delete"
										variant="danger"
										onClick={() => handleDelete(t)}
									/>
								</div>
							</td>
						</DataRow>
					))}
				</DataTable>
			)}
		</div>
	);
}
