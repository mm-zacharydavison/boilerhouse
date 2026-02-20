import { useState, useCallback } from "react";
import { useApi } from "../hooks";
import { api, type InstanceSummary } from "../api";
import {
	LoadingState,
	ErrorState,
	StatusIndicator,
	ActionButton,
	DataTable,
	DataRow,
} from "../components";

const STATUSES = ["", "starting", "running", "hibernated", "stopping", "destroyed"] as const;

export function InstanceList({ navigate }: { navigate: (path: string) => void }) {
	const [statusFilter, setStatusFilter] = useState("");
	const fetcher = useCallback(
		() => api.fetchInstances(statusFilter || undefined),
		[statusFilter],
	);
	const { data, loading, error, refetch } = useApi<InstanceSummary[]>(fetcher);

	async function handleAction(
		instanceId: string,
		action: "stop" | "hibernate" | "destroy",
	) {
		try {
			if (action === "stop") await api.stopInstance(instanceId);
			else if (action === "hibernate") await api.hibernateInstance(instanceId);
			else await api.destroyInstance(instanceId);
			refetch();
		} catch (err) {
			alert(err instanceof Error ? err.message : "Action failed");
		}
	}

	return (
		<div>
			<div className="flex items-center justify-between mb-6">
				<h2 className="text-xl font-tight font-semibold">instances</h2>
				<select
					value={statusFilter}
					onChange={(e) => setStatusFilter(e.target.value)}
					className="bg-surface-2 border border-border rounded-sm px-3 py-1.5 text-sm font-mono text-muted-light"
				>
					{STATUSES.map((s) => (
						<option key={s} value={s}>
							{s || "all statuses"}
						</option>
					))}
				</select>
			</div>

			{loading ? (
				<LoadingState />
			) : error ? (
				<ErrorState message={error} />
			) : !data || data.length === 0 ? (
				<p className="text-muted font-mono text-sm">no instances found.</p>
			) : (
				<DataTable headers={["Instance ID", "Status", "Workload", "Node", "Tenant", "Created", "Actions"]}>
					{data.map((inst) => (
						<DataRow key={inst.instanceId}>
							<td
								className="px-4 py-3 text-accent hover:text-accent-bright cursor-pointer"
								onClick={() => navigate(`/instances/${inst.instanceId}`)}
							>
								{inst.instanceId.slice(0, 12)}...
							</td>
							<td className="px-4 py-3">
								<StatusIndicator status={inst.status} />
							</td>
							<td className="px-4 py-3 text-muted-light text-xs">
								{inst.workloadId.slice(0, 12)}...
							</td>
							<td className="px-4 py-3 text-muted-light text-xs">
								{inst.nodeId.slice(0, 12)}...
							</td>
							<td className="px-4 py-3 text-muted-light text-xs">
								{inst.tenantId ? `${inst.tenantId.slice(0, 12)}...` : "-"}
							</td>
							<td className="px-4 py-3 text-muted">
								{new Date(inst.createdAt).toLocaleString()}
							</td>
							<td className="px-4 py-3">
								{inst.status !== "destroyed" && (
									<div className="flex gap-1">
										{inst.status === "running" && (
											<>
												<ActionButton
													label="stop"
													variant="warning"
													onClick={() => handleAction(inst.instanceId, "stop")}
												/>
												<ActionButton
													label="hibernate"
													variant="info"
													onClick={() => handleAction(inst.instanceId, "hibernate")}
												/>
											</>
										)}
										<ActionButton
											label="destroy"
											variant="danger"
											onClick={() => handleAction(inst.instanceId, "destroy")}
										/>
									</div>
								)}
							</td>
						</DataRow>
					))}
				</DataTable>
			)}
		</div>
	);
}
