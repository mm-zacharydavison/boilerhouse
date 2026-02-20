import { useApi } from "../hooks";
import { api, type StatsResponse } from "../api";
import { LoadingState, ErrorState, StatCard, StatusIndicator, PageHeader } from "../components";

export function Overview() {
	const { data, loading, error } = useApi<StatsResponse>(api.fetchStats);

	if (loading) return <LoadingState />;
	if (error) return <ErrorState message={error} />;
	if (!data) return null;

	const totalInstances = Object.values(data.instances).reduce((sum, n) => sum + n, 0);

	return (
		<div>
			<PageHeader>overview</PageHeader>
			<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
				<StatCard label="Total Instances" value={totalInstances} />
				<StatCard label="Snapshots" value={data.snapshots} />
				<StatCard label="Nodes" value={data.nodes} />
			</div>

			{Object.keys(data.instances).length > 0 && (
				<div>
					<h3 className="text-sm font-tight uppercase tracking-wider text-muted mb-3">
						Instances by Status
					</h3>
					<div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
						{Object.entries(data.instances).map(([status, count]) => (
							<div key={status} className="bg-surface-2 rounded-md p-4">
								<StatusIndicator status={status} />
								<p className="text-2xl font-bold font-mono mt-1">{count}</p>
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
