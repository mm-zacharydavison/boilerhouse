import { useApi } from "../hooks";
import { api, type TenantSummary } from "../api";
import { LoadingSpinner, ErrorMessage } from "./Overview";

export function TenantList() {
	const { data, loading, error } = useApi<TenantSummary[]>(api.fetchTenants);

	if (loading) return <LoadingSpinner />;
	if (error) return <ErrorMessage message={error} />;
	if (!data) return null;

	return (
		<div>
			<h2 className="text-2xl font-semibold mb-6">Tenants</h2>
			{data.length === 0 ? (
				<p className="text-gray-400">No tenants found.</p>
			) : (
				<div className="overflow-x-auto">
					<table className="w-full text-sm text-left">
						<thead className="text-xs text-gray-400 uppercase border-b border-gray-800">
							<tr>
								<th className="px-4 py-3">Tenant ID</th>
								<th className="px-4 py-3">Workload</th>
								<th className="px-4 py-3">Instance</th>
								<th className="px-4 py-3">Last Activity</th>
								<th className="px-4 py-3">Created</th>
							</tr>
						</thead>
						<tbody>
							{data.map((t) => (
								<tr key={t.tenantId} className="border-b border-gray-800/50 hover:bg-gray-900/50">
									<td className="px-4 py-3 font-mono text-gray-200">
										{t.tenantId}
									</td>
									<td className="px-4 py-3 font-mono text-gray-300 text-xs">
										{t.workloadId.slice(0, 12)}...
									</td>
									<td className="px-4 py-3 font-mono text-gray-300 text-xs">
										{t.instanceId ? (
											<a
												href={`#/instances/${t.instanceId}`}
												className="text-blue-400 hover:underline"
											>
												{t.instanceId.slice(0, 12)}...
											</a>
										) : (
											<span className="text-gray-500">-</span>
										)}
									</td>
									<td className="px-4 py-3 text-gray-400">
										{t.lastActivity
											? new Date(t.lastActivity).toLocaleString()
											: "-"}
									</td>
									<td className="px-4 py-3 text-gray-400">
										{new Date(t.createdAt).toLocaleString()}
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
