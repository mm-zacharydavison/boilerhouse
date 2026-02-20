import { useApi } from "../hooks";
import { api, type NodeSummary } from "../api";
import { LoadingSpinner, ErrorMessage } from "./Overview";

export function NodeList() {
	const { data, loading, error } = useApi<NodeSummary[]>(api.fetchNodes);

	if (loading) return <LoadingSpinner />;
	if (error) return <ErrorMessage message={error} />;
	if (!data) return null;

	return (
		<div>
			<h2 className="text-2xl font-semibold mb-6">Nodes</h2>
			{data.length === 0 ? (
				<p className="text-gray-400">No nodes registered.</p>
			) : (
				<div className="overflow-x-auto">
					<table className="w-full text-sm text-left">
						<thead className="text-xs text-gray-400 uppercase border-b border-gray-800">
							<tr>
								<th className="px-4 py-3">Node ID</th>
								<th className="px-4 py-3">Runtime</th>
								<th className="px-4 py-3">Status</th>
								<th className="px-4 py-3">vCPUs</th>
								<th className="px-4 py-3">Memory</th>
								<th className="px-4 py-3">Disk</th>
								<th className="px-4 py-3">Last Heartbeat</th>
								<th className="px-4 py-3">Created</th>
							</tr>
						</thead>
						<tbody>
							{data.map((n) => (
								<tr key={n.nodeId} className="border-b border-gray-800/50 hover:bg-gray-900/50">
									<td className="px-4 py-3 font-mono text-gray-200">
										{n.nodeId}
									</td>
									<td className="px-4 py-3 text-gray-300">{n.runtimeType}</td>
									<td className="px-4 py-3">
										<NodeStatusBadge status={n.status} />
									</td>
									<td className="px-4 py-3 text-gray-300">{n.capacity.vcpus}</td>
									<td className="px-4 py-3 text-gray-300">
										{n.capacity.memoryMb} MB
									</td>
									<td className="px-4 py-3 text-gray-300">
										{n.capacity.diskGb} GB
									</td>
									<td className="px-4 py-3 text-gray-400">
										{new Date(n.lastHeartbeat).toLocaleString()}
									</td>
									<td className="px-4 py-3 text-gray-400">
										{new Date(n.createdAt).toLocaleString()}
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

function NodeStatusBadge({ status }: { status: string }) {
	const colors: Record<string, string> = {
		online: "bg-green-900/50 text-green-400 border-green-800",
		offline: "bg-red-900/50 text-red-400 border-red-800",
		draining: "bg-yellow-900/50 text-yellow-400 border-yellow-800",
	};
	const cls = colors[status] ?? "bg-gray-800 text-gray-400 border-gray-700";

	return (
		<span className={`inline-block px-2 py-0.5 text-xs font-medium rounded border ${cls}`}>
			{status}
		</span>
	);
}
