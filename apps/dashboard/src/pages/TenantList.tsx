import { useApi } from "../hooks";
import { api, type TenantSummary } from "../api";
import { LoadingState, ErrorState, PageHeader, DataTable, DataRow } from "../components";

export function TenantList() {
	const { data, loading, error } = useApi<TenantSummary[]>(api.fetchTenants);

	if (loading) return <LoadingState />;
	if (error) return <ErrorState message={error} />;
	if (!data) return null;

	return (
		<div>
			<PageHeader>tenants</PageHeader>
			{data.length === 0 ? (
				<p className="text-muted font-mono text-sm">no tenants found.</p>
			) : (
				<DataTable headers={["Tenant ID", "Workload", "Instance", "Last Activity", "Created"]}>
					{data.map((t) => (
						<DataRow key={t.tenantId}>
							<td className="px-4 py-3 text-gray-200">
								{t.tenantId}
							</td>
							<td className="px-4 py-3 text-muted-light text-xs">
								{t.workloadId.slice(0, 12)}...
							</td>
							<td className="px-4 py-3 text-xs">
								{t.instanceId ? (
									<a
										href={`#/instances/${t.instanceId}`}
										className="text-accent hover:text-accent-bright"
									>
										{t.instanceId.slice(0, 12)}...
									</a>
								) : (
									<span className="text-muted">-</span>
								)}
							</td>
							<td className="px-4 py-3 text-muted">
								{t.lastActivity
									? new Date(t.lastActivity).toLocaleString()
									: "-"}
							</td>
							<td className="px-4 py-3 text-muted">
								{new Date(t.createdAt).toLocaleString()}
							</td>
						</DataRow>
					))}
				</DataTable>
			)}
		</div>
	);
}
