import { useState, useCallback } from "react";
import { useApi } from "../hooks";
import { api, type InstanceSummary } from "../api";
import { LoadingSpinner, ErrorMessage, StatusBadge } from "./Overview";

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
				<h2 className="text-2xl font-semibold">Instances</h2>
				<select
					value={statusFilter}
					onChange={(e) => setStatusFilter(e.target.value)}
					className="bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-300"
				>
					{STATUSES.map((s) => (
						<option key={s} value={s}>
							{s || "All statuses"}
						</option>
					))}
				</select>
			</div>

			{loading ? (
				<LoadingSpinner />
			) : error ? (
				<ErrorMessage message={error} />
			) : !data || data.length === 0 ? (
				<p className="text-gray-400">No instances found.</p>
			) : (
				<div className="overflow-x-auto">
					<table className="w-full text-sm text-left">
						<thead className="text-xs text-gray-400 uppercase border-b border-gray-800">
							<tr>
								<th className="px-4 py-3">Instance ID</th>
								<th className="px-4 py-3">Status</th>
								<th className="px-4 py-3">Workload</th>
								<th className="px-4 py-3">Node</th>
								<th className="px-4 py-3">Tenant</th>
								<th className="px-4 py-3">Created</th>
								<th className="px-4 py-3">Actions</th>
							</tr>
						</thead>
						<tbody>
							{data.map((inst) => (
								<tr key={inst.instanceId} className="border-b border-gray-800/50 hover:bg-gray-900/50">
									<td
										className="px-4 py-3 font-mono text-blue-400 hover:underline cursor-pointer"
										onClick={() => navigate(`/instances/${inst.instanceId}`)}
									>
										{inst.instanceId.slice(0, 12)}...
									</td>
									<td className="px-4 py-3">
										<StatusBadge status={inst.status} />
									</td>
									<td className="px-4 py-3 font-mono text-gray-300 text-xs">
										{inst.workloadId.slice(0, 12)}...
									</td>
									<td className="px-4 py-3 font-mono text-gray-300 text-xs">
										{inst.nodeId.slice(0, 12)}...
									</td>
									<td className="px-4 py-3 font-mono text-gray-300 text-xs">
										{inst.tenantId ? `${inst.tenantId.slice(0, 12)}...` : "-"}
									</td>
									<td className="px-4 py-3 text-gray-400">
										{new Date(inst.createdAt).toLocaleString()}
									</td>
									<td className="px-4 py-3">
										<ActionButtons
											status={inst.status}
											onAction={(action) => handleAction(inst.instanceId, action)}
										/>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}

function ActionButtons({
	status,
	onAction,
}: {
	status: string;
	onAction: (action: "stop" | "hibernate" | "destroy") => void;
}) {
	if (status === "destroyed") return null;

	return (
		<div className="flex gap-1">
			{status === "running" && (
				<>
					<ActionBtn label="Stop" onClick={() => onAction("stop")} color="yellow" />
					<ActionBtn label="Hibernate" onClick={() => onAction("hibernate")} color="blue" />
				</>
			)}
			<ActionBtn label="Destroy" onClick={() => onAction("destroy")} color="red" />
		</div>
	);
}

function ActionBtn({
	label,
	onClick,
	color,
}: {
	label: string;
	onClick: () => void;
	color: "red" | "yellow" | "blue";
}) {
	const colors = {
		red: "text-red-400 hover:bg-red-900/30 border-red-800",
		yellow: "text-yellow-400 hover:bg-yellow-900/30 border-yellow-800",
		blue: "text-blue-400 hover:bg-blue-900/30 border-blue-800",
	};

	return (
		<button
			onClick={(e) => {
				e.stopPropagation();
				onClick();
			}}
			className={`px-2 py-1 text-xs rounded border transition-colors ${colors[color]}`}
		>
			{label}
		</button>
	);
}
