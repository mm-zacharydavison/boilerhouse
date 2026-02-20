import { useApi } from "../hooks";
import { api } from "../api";
import { LoadingSpinner, ErrorMessage, StatusBadge } from "./Overview";

export function InstanceDetail({ id }: { id: string }) {
	const { data, loading, error, refetch } = useApi(() => api.fetchInstance(id));

	async function handleAction(action: "stop" | "hibernate" | "destroy") {
		try {
			if (action === "stop") await api.stopInstance(id);
			else if (action === "hibernate") await api.hibernateInstance(id);
			else await api.destroyInstance(id);
			refetch();
		} catch (err) {
			alert(err instanceof Error ? err.message : "Action failed");
		}
	}

	if (loading) return <LoadingSpinner />;
	if (error) return <ErrorMessage message={error} />;
	if (!data) return null;

	return (
		<div>
			<a
				href="#/instances"
				className="text-sm text-gray-400 hover:text-white mb-4 inline-block transition-colors"
			>
				&larr; Back to Instances
			</a>

			<div className="flex items-center gap-3 mb-6">
				<h2 className="text-2xl font-semibold font-mono">{data.instanceId}</h2>
				<StatusBadge status={data.status} />
			</div>

			{data.status !== "destroyed" && (
				<div className="flex gap-2 mb-6">
					{data.status === "running" && (
						<>
							<button
								onClick={() => handleAction("stop")}
								className="px-3 py-1.5 text-sm rounded border border-yellow-800 text-yellow-400 hover:bg-yellow-900/30 transition-colors"
							>
								Stop
							</button>
							<button
								onClick={() => handleAction("hibernate")}
								className="px-3 py-1.5 text-sm rounded border border-blue-800 text-blue-400 hover:bg-blue-900/30 transition-colors"
							>
								Hibernate
							</button>
						</>
					)}
					<button
						onClick={() => handleAction("destroy")}
						className="px-3 py-1.5 text-sm rounded border border-red-800 text-red-400 hover:bg-red-900/30 transition-colors"
					>
						Destroy
					</button>
				</div>
			)}

			<div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
				<InfoItem label="Workload ID" value={data.workloadId} />
				<InfoItem label="Node ID" value={data.nodeId} />
				<InfoItem label="Tenant ID" value={data.tenantId ?? "-"} />
				<InfoItem label="Status" value={data.status} />
				<InfoItem label="Created" value={new Date(data.createdAt).toLocaleString()} />
				<InfoItem
					label="Last Activity"
					value={data.lastActivity ? new Date(data.lastActivity).toLocaleString() : "-"}
				/>
				<InfoItem
					label="Claimed At"
					value={data.claimedAt ? new Date(data.claimedAt).toLocaleString() : "-"}
				/>
			</div>

			{data.runtimeMeta != null && (
				<div>
					<h3 className="text-lg font-medium mb-3 text-gray-300">Runtime Metadata</h3>
					<pre className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-sm text-gray-300 overflow-x-auto">
						{JSON.stringify(data.runtimeMeta, null, 2)}
					</pre>
				</div>
			)}
		</div>
	);
}

function InfoItem({ label, value }: { label: string; value: string }) {
	return (
		<div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
			<p className="text-xs text-gray-400 uppercase mb-1">{label}</p>
			<p className="text-sm font-mono text-gray-200 break-all">{value}</p>
		</div>
	);
}
