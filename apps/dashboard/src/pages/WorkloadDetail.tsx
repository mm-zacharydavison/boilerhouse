import { useApi } from "../hooks";
import { api } from "../api";
import { LoadingSpinner, ErrorMessage } from "./Overview";

export function WorkloadDetail({
	name,
	navigate,
}: {
	name: string;
	navigate: (path: string) => void;
}) {
	const { data, loading, error } = useApi(() => api.fetchWorkload(name));

	if (loading) return <LoadingSpinner />;
	if (error) return <ErrorMessage message={error} />;
	if (!data) return null;

	return (
		<div>
			<button
				onClick={() => navigate("/workloads")}
				className="text-sm text-gray-400 hover:text-white mb-4 inline-block transition-colors"
			>
				&larr; Back to Workloads
			</button>

			<h2 className="text-2xl font-semibold mb-6">{data.name}</h2>

			<div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
				<InfoItem label="Workload ID" value={data.workloadId} />
				<InfoItem label="Version" value={data.version} />
				<InfoItem label="Instances" value={String(data.instanceCount)} />
				<InfoItem label="Created" value={new Date(data.createdAt).toLocaleString()} />
				<InfoItem label="Updated" value={new Date(data.updatedAt).toLocaleString()} />
			</div>

			{data.config != null && (
				<div>
					<h3 className="text-lg font-medium mb-3 text-gray-300">Configuration</h3>
					<pre className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-sm text-gray-300 overflow-x-auto">
						{JSON.stringify(data.config, null, 2)}
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
