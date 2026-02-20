import { useApi } from "../hooks";
import { api, type StatsResponse } from "../api";

export function Overview() {
	const { data, loading, error } = useApi<StatsResponse>(api.fetchStats);

	if (loading) return <LoadingSpinner />;
	if (error) return <ErrorMessage message={error} />;
	if (!data) return null;

	const totalInstances = Object.values(data.instances).reduce((sum, n) => sum + n, 0);

	return (
		<div>
			<h2 className="text-2xl font-semibold mb-6">Overview</h2>
			<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
				<StatCard label="Total Instances" value={totalInstances} />
				<StatCard label="Snapshots" value={data.snapshots} />
				<StatCard label="Nodes" value={data.nodes} />
			</div>

			{Object.keys(data.instances).length > 0 && (
				<div>
					<h3 className="text-lg font-medium mb-3 text-gray-300">Instances by Status</h3>
					<div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
						{Object.entries(data.instances).map(([status, count]) => (
							<div
								key={status}
								className="bg-gray-900 border border-gray-800 rounded-lg p-4"
							>
								<StatusBadge status={status} />
								<p className="text-2xl font-bold mt-1">{count}</p>
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);
}

function StatCard({ label, value }: { label: string; value: number }) {
	return (
		<div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
			<p className="text-sm text-gray-400">{label}</p>
			<p className="text-3xl font-bold mt-1">{value}</p>
		</div>
	);
}

export function StatusBadge({ status }: { status: string }) {
	const colors: Record<string, string> = {
		running: "bg-green-900/50 text-green-400 border-green-800",
		hibernated: "bg-blue-900/50 text-blue-400 border-blue-800",
		starting: "bg-yellow-900/50 text-yellow-400 border-yellow-800",
		stopping: "bg-orange-900/50 text-orange-400 border-orange-800",
		destroyed: "bg-red-900/50 text-red-400 border-red-800",
	};
	const cls = colors[status] ?? "bg-gray-800 text-gray-400 border-gray-700";

	return (
		<span className={`inline-block px-2 py-0.5 text-xs font-medium rounded border ${cls}`}>
			{status}
		</span>
	);
}

export function LoadingSpinner() {
	return (
		<div className="flex items-center justify-center py-20">
			<div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-blue-500"></div>
		</div>
	);
}

export function ErrorMessage({ message }: { message: string }) {
	return (
		<div className="bg-red-900/30 border border-red-800 rounded-lg p-4 text-red-400">
			{message}
		</div>
	);
}
