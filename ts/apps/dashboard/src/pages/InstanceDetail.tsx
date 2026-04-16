import { useState, useEffect, useRef } from "react";
import { useApi } from "../hooks";
import { api } from "../api";
import { LoadingState, ErrorState, PageHeader, InfoCard, BackLink, StatusIndicator, ActionButton } from "../components";

export function InstanceDetail({
	instanceId,
	navigate,
}: {
	instanceId: string;
	navigate: (path: string) => void;
}) {
	const { data, loading, error } = useApi(() => api.fetchInstance(instanceId));
	const [logs, setLogs] = useState<string | null>(null);
	const [logsError, setLogsError] = useState<string | null>(null);
	const [logsLoading, setLogsLoading] = useState(false);
	const [autoRefresh, setAutoRefresh] = useState(true);
	const [copied, setCopied] = useState(false);
	const logContainerRef = useRef<HTMLDivElement>(null);

	const isLive = data && data.phase !== "Succeeded" && data.phase !== "Failed";

	function fetchLogs() {
		if (!isLive) return;
		setLogsLoading(true);
		api.fetchInstanceLogs(instanceId)
			.then((text) => {
				setLogs(typeof text === "string" ? text : null);
				setLogsError(null);
			})
			.catch((err) => {
				setLogsError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => setLogsLoading(false));
	}

	useEffect(() => {
		if (!isLive) return;
		fetchLogs();
	}, [isLive, instanceId]);

	// Auto-refresh logs every 3 seconds
	useEffect(() => {
		if (!isLive || !autoRefresh) return;
		const timer = setInterval(fetchLogs, 3000);
		return () => clearInterval(timer);
	}, [isLive, autoRefresh, instanceId]);

	// Auto-scroll log panel
	useEffect(() => {
		if (logContainerRef.current) {
			logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
		}
	}, [logs]);

	if (loading) return <LoadingState />;
	if (error) return <ErrorState message={error} />;
	if (!data) return null;

	return (
		<div>
			<BackLink label="workloads" onClick={() => navigate("/workloads")} />

			<PageHeader>Instance {instanceId.slice(0, 16)}</PageHeader>

			{/* Status + metadata */}
			<div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
				<div className="bg-surface-2 rounded-md p-4">
					<p className="text-xs font-tight uppercase tracking-wider text-muted mb-1">Phase</p>
					<StatusIndicator status={data.phase} />
				</div>
				<InfoCard label="Name" value={data.name} />
				<InfoCard label="Workload" value={data.workloadRef ?? "unknown"} />
				<InfoCard label="Tenant" value={data.tenantId ?? "none (pool)"} />
				{data.ip && <InfoCard label="Pod IP" value={data.ip} />}
				<InfoCard label="Created" value={new Date(data.createdAt).toLocaleString()} />
			</div>

			{/* Container Logs */}
			<div className="mb-6">
				<div className="flex items-center justify-between mb-3">
					<h3 className="text-sm font-tight uppercase tracking-wider text-muted">
						Container Logs
					</h3>
					<div className="flex items-center gap-2">
						{isLive && (
							<>
								<label className="flex items-center gap-1.5 text-xs text-muted">
									<input
										type="checkbox"
										checked={autoRefresh}
										onChange={(e) => setAutoRefresh(e.target.checked)}
										className="rounded"
									/>
									auto-refresh
								</label>
								<ActionButton
									label={logsLoading ? "loading..." : "refresh"}
									variant="info"
									disabled={logsLoading}
									onClick={fetchLogs}
								/>
							</>
						)}
						{logs && logs.length > 0 && (
							<ActionButton
								label={copied ? "copied!" : "copy"}
								variant="info"
								onClick={() => {
									navigator.clipboard.writeText(logs);
									setCopied(true);
									setTimeout(() => setCopied(false), 2000);
								}}
							/>
						)}
					</div>
				</div>
				<div className="bg-surface-2 rounded-md">
					{!isLive ? (
						<p className="p-4 text-xs font-mono text-muted">
							Instance is {data.phase} -- no logs available.
						</p>
					) : logsError ? (
						<p className="p-4 text-xs font-mono text-status-red">{logsError}</p>
					) : logs === null ? (
						<p className="p-4 text-xs font-mono text-muted">Loading logs...</p>
					) : logs.length === 0 ? (
						<p className="p-4 text-xs font-mono text-muted">No output yet.</p>
					) : (
						<div
							ref={logContainerRef}
							className="p-4 max-h-96 overflow-y-auto"
						>
							{logs.split("\n").map((line, i) => (
								<div key={i} className="text-xs font-mono leading-5 text-muted-light whitespace-pre-wrap">
									{line}
								</div>
							))}
						</div>
					)}
				</div>
			</div>

			{/* Labels */}
			{data.labels && Object.keys(data.labels).length > 0 && (
				<div className="mb-6">
					<h3 className="text-sm font-tight uppercase tracking-wider text-muted mb-3">
						Labels
					</h3>
					<div className="bg-surface-2 rounded-md p-4">
						<div className="flex flex-wrap gap-2">
							{Object.entries(data.labels).map(([k, v]) => (
								<span key={k} className="text-xs font-mono px-2 py-0.5 bg-surface-3 rounded border border-border/30">
									<span className="text-muted">{k}</span>=<span className="text-muted-light">{v}</span>
								</span>
							))}
						</div>
					</div>
				</div>
			)}

			{/* Actions */}
			{isLive && (
				<div className="flex gap-2">
					<ActionButton
						label="destroy"
						variant="danger"
						onClick={async () => {
							await api.destroyInstance(instanceId);
							navigate("/workloads");
						}}
					/>
				</div>
			)}
		</div>
	);
}
