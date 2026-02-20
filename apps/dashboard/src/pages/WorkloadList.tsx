import { useApi } from "../hooks";
import { api, type WorkloadSummary } from "../api";
import { LoadingSpinner, ErrorMessage } from "./Overview";

export function WorkloadList({ navigate }: { navigate: (path: string) => void }) {
	const { data, loading, error } = useApi<WorkloadSummary[]>(api.fetchWorkloads);

	if (loading) return <LoadingSpinner />;
	if (error) return <ErrorMessage message={error} />;
	if (!data) return null;

	return (
		<div>
			<h2 className="text-2xl font-semibold mb-6">Workloads</h2>
			{data.length === 0 ? (
				<p className="text-gray-400">No workloads registered.</p>
			) : (
				<div className="overflow-x-auto">
					<table className="w-full text-sm text-left">
						<thead className="text-xs text-gray-400 uppercase border-b border-gray-800">
							<tr>
								<th className="px-4 py-3">Name</th>
								<th className="px-4 py-3">Version</th>
								<th className="px-4 py-3">Created</th>
								<th className="px-4 py-3">Updated</th>
							</tr>
						</thead>
						<tbody>
							{data.map((w) => (
								<tr
									key={w.workloadId}
									className="border-b border-gray-800/50 hover:bg-gray-900/50 cursor-pointer transition-colors"
									onClick={() => navigate(`/workloads/${w.name}`)}
								>
									<td className="px-4 py-3 font-medium text-blue-400 hover:underline">
										{w.name}
									</td>
									<td className="px-4 py-3 text-gray-300">{w.version}</td>
									<td className="px-4 py-3 text-gray-400">
										{new Date(w.createdAt).toLocaleString()}
									</td>
									<td className="px-4 py-3 text-gray-400">
										{new Date(w.updatedAt).toLocaleString()}
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
