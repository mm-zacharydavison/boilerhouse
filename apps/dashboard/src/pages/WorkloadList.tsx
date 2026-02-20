import { useApi } from "../hooks";
import { api, type WorkloadSummary } from "../api";
import { LoadingState, ErrorState, PageHeader, DataTable, DataRow } from "../components";

export function WorkloadList({ navigate }: { navigate: (path: string) => void }) {
	const { data, loading, error } = useApi<WorkloadSummary[]>(api.fetchWorkloads);

	if (loading) return <LoadingState />;
	if (error) return <ErrorState message={error} />;
	if (!data) return null;

	return (
		<div>
			<PageHeader>workloads</PageHeader>
			{data.length === 0 ? (
				<p className="text-muted font-mono text-sm">no workloads registered.</p>
			) : (
				<DataTable headers={["Name", "Version", "Created", "Updated"]}>
					{data.map((w) => (
						<DataRow key={w.workloadId} onClick={() => navigate(`/workloads/${w.name}`)}>
							<td className="px-4 py-3 text-accent hover:text-accent-bright">
								{w.name}
							</td>
							<td className="px-4 py-3 text-muted-light">{w.version}</td>
							<td className="px-4 py-3 text-muted">
								{new Date(w.createdAt).toLocaleString()}
							</td>
							<td className="px-4 py-3 text-muted">
								{new Date(w.updatedAt).toLocaleString()}
							</td>
						</DataRow>
					))}
				</DataTable>
			)}
		</div>
	);
}
