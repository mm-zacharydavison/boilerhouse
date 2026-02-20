import { useApi } from "../hooks";
import { api } from "../api";
import {
	LoadingState,
	ErrorState,
	InfoCard,
	BackLink,
	StatusIndicator,
	ActionButton,
} from "../components";

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

	if (loading) return <LoadingState />;
	if (error) return <ErrorState message={error} />;
	if (!data) return null;

	return (
		<div>
			<BackLink href="#/instances" label="instances" />

			<div className="flex items-center gap-3 mb-6">
				<h2 className="text-xl font-tight font-semibold font-mono">{data.instanceId}</h2>
				<StatusIndicator status={data.status} />
			</div>

			{data.status !== "destroyed" && (
				<div className="flex gap-2 mb-6">
					{data.status === "running" && (
						<>
							<ActionButton
								label="stop"
								variant="warning"
								onClick={() => handleAction("stop")}
							/>
							<ActionButton
								label="hibernate"
								variant="info"
								onClick={() => handleAction("hibernate")}
							/>
						</>
					)}
					<ActionButton
						label="destroy"
						variant="danger"
						onClick={() => handleAction("destroy")}
					/>
				</div>
			)}

			<div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
				<InfoCard label="Workload ID" value={data.workloadId} />
				<InfoCard label="Node ID" value={data.nodeId} />
				<InfoCard label="Tenant ID" value={data.tenantId ?? "-"} />
				<InfoCard label="Status" value={data.status} />
				<InfoCard label="Created" value={new Date(data.createdAt).toLocaleString()} />
				<InfoCard
					label="Last Activity"
					value={data.lastActivity ? new Date(data.lastActivity).toLocaleString() : "-"}
				/>
				<InfoCard
					label="Claimed At"
					value={data.claimedAt ? new Date(data.claimedAt).toLocaleString() : "-"}
				/>
			</div>

			{data.runtimeMeta != null && (
				<div>
					<h3 className="text-sm font-tight uppercase tracking-wider text-muted mb-3">
						Runtime Metadata
					</h3>
					<pre className="bg-surface-2 rounded-md p-4 text-sm font-mono text-muted-light overflow-x-auto">
						{JSON.stringify(data.runtimeMeta, null, 2)}
					</pre>
				</div>
			)}
		</div>
	);
}
