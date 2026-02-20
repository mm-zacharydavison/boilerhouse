import { useApi } from "../hooks";
import { api } from "../api";
import { LoadingState, ErrorState, PageHeader, InfoCard, BackLink } from "../components";

export function WorkloadDetail({
	name,
	navigate,
}: {
	name: string;
	navigate: (path: string) => void;
}) {
	const { data, loading, error } = useApi(() => api.fetchWorkload(name));

	if (loading) return <LoadingState />;
	if (error) return <ErrorState message={error} />;
	if (!data) return null;

	return (
		<div>
			<BackLink label="workloads" onClick={() => navigate("/workloads")} />

			<PageHeader>{data.name}</PageHeader>

			<div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
				<InfoCard label="Workload ID" value={data.workloadId} />
				<InfoCard label="Version" value={data.version} />
				<InfoCard label="Instances" value={String(data.instanceCount)} />
				<InfoCard label="Created" value={new Date(data.createdAt).toLocaleString()} />
				<InfoCard label="Updated" value={new Date(data.updatedAt).toLocaleString()} />
			</div>

			{data.config != null && (
				<div>
					<h3 className="text-sm font-tight uppercase tracking-wider text-muted mb-3">
						Configuration
					</h3>
					<pre className="bg-surface-2 rounded-md p-4 text-sm font-mono text-muted-light overflow-x-auto">
						{JSON.stringify(data.config, null, 2)}
					</pre>
				</div>
			)}
		</div>
	);
}
