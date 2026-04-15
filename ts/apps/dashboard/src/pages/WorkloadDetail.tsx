import { useState } from "react";
import { useApi } from "../hooks";
import { api, type ClaimResponse } from "../api";
import { LoadingState, ErrorState, PageHeader, InfoCard, BackLink, ActionButton, StatusIndicator } from "../components";
import { JsonSyntax } from "../json-syntax";

export function WorkloadDetail({
	name,
	navigate,
}: {
	name: string;
	navigate: (path: string) => void;
}) {
	const { data, loading, error } = useApi(() => api.fetchWorkload(name));

	const [tenantId, setTenantId] = useState("");
	const [claiming, setClaiming] = useState(false);
	const [claimResult, setClaimResult] = useState<ClaimResponse | null>(null);
	const [claimError, setClaimError] = useState<string | null>(null);

	async function handleClaim() {
		if (!tenantId.trim() || !data) return;
		setClaiming(true);
		setClaimResult(null);
		setClaimError(null);
		try {
			const result = await api.claimWorkload(tenantId.trim(), data.name);
			setClaimResult(result);
		} catch (err) {
			setClaimError(err instanceof Error ? err.message : "Claim failed");
		} finally {
			setClaiming(false);
		}
	}

	if (loading) return <LoadingState />;
	if (error) return <ErrorState message={error} />;
	if (!data) return null;

	const phase = data.status.phase ?? "Unknown";
	const isReady = phase === "Ready";

	return (
		<div>
			<BackLink label="workloads" onClick={() => navigate("/workloads")} />

			<PageHeader>{data.name}</PageHeader>

			<div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
				<InfoCard label="Version" value={data.spec.version} />
				<InfoCard label="Image" value={data.spec.image.ref} />
				<div className="bg-surface-2 rounded-md p-4">
					<p className="text-xs font-tight uppercase tracking-wider text-muted mb-1">Status</p>
					<StatusIndicator status={phase} detail={data.status.detail ?? undefined} />
				</div>
				<InfoCard label="Resources" value={`${data.spec.resources.vcpus} vCPU, ${data.spec.resources.memoryMb} MB, ${data.spec.resources.diskGb} GB`} />
				{data.spec.idle?.timeoutSeconds && (
					<InfoCard label="Idle Timeout" value={`${data.spec.idle.timeoutSeconds}s (${data.spec.idle.action ?? "hibernate"})`} />
				)}
				<InfoCard label="Created" value={new Date(data.createdAt).toLocaleString()} />
			</div>

			{/* Claim section */}
			<div className="mb-6">
				<h3 className="text-sm font-tight uppercase tracking-wider text-muted mb-3">
					Claim for Tenant
				</h3>
				{!isReady && (
					<p className="text-sm text-status-yellow mb-2">
						Workload is not ready -- claims are disabled until the workload reaches Ready phase.
					</p>
				)}
				<div className="flex items-center gap-2">
					<input
						type="text"
						placeholder="tenant-id"
						value={tenantId}
						disabled={!isReady}
						onChange={(e) => setTenantId(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") handleClaim();
						}}
						className="bg-surface-2 border border-border rounded-md px-3 py-1 text-sm font-mono text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-status-blue disabled:opacity-50"
					/>
					<ActionButton
						label={claiming ? "claiming..." : "claim"}
						variant="info"
						disabled={!isReady || claiming || !tenantId.trim()}
						onClick={handleClaim}
					/>
				</div>

				{claimError && (
					<p className="mt-2 text-sm text-status-red">{claimError}</p>
				)}

				{claimResult && (
					<div className="mt-2 text-sm text-muted-light space-y-1">
						<p>Phase: {claimResult.phase}</p>
						{claimResult.instanceId && (
							<p>
								Instance:{" "}
								<a
									href={`#/instances/${claimResult.instanceId}`}
									className="text-status-blue hover:underline font-mono"
								>
									{claimResult.instanceId}
								</a>
							</p>
						)}
						{claimResult.source && <p>Source: {claimResult.source}</p>}
						{claimResult.endpoint && (
							<p>Endpoint: {claimResult.endpoint.host}:{claimResult.endpoint.port}</p>
						)}
					</div>
				)}
			</div>

			<div>
				<h3 className="text-sm font-tight uppercase tracking-wider text-muted mb-3">
					Spec
				</h3>
				<JsonSyntax data={data.spec} />
			</div>
		</div>
	);
}
