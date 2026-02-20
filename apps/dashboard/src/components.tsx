import type { ReactNode } from "react";

// --- Status Indicator ---

const STATUS_SYMBOLS: Record<string, string> = {
	running: "●",
	online: "●",
	starting: "◐",
	draining: "◐",
	stopping: "◐",
	hibernated: "○",
	destroyed: "✕",
	offline: "✕",
};

const STATUS_COLORS: Record<string, string> = {
	running: "text-status-green",
	online: "text-status-green",
	starting: "text-status-yellow",
	draining: "text-status-yellow",
	stopping: "text-status-orange",
	hibernated: "text-status-blue",
	destroyed: "text-status-red",
	offline: "text-status-red",
};

export function StatusIndicator({ status }: { status: string }) {
	const symbol = STATUS_SYMBOLS[status] ?? "●";
	const color = STATUS_COLORS[status] ?? "text-muted";

	return (
		<span className={`font-mono text-sm ${color}`}>
			{symbol} {status}
		</span>
	);
}

// --- Info Card ---

export function InfoCard({ label, value }: { label: string; value: string }) {
	return (
		<div className="bg-surface-2 rounded-md p-4">
			<p className="text-xs font-tight uppercase tracking-wider text-muted mb-1">{label}</p>
			<p className="text-sm font-mono text-gray-200 break-all">{value}</p>
		</div>
	);
}

// --- Stat Card ---

export function StatCard({ label, value }: { label: string; value: number }) {
	return (
		<div className="bg-surface-2 rounded-md p-5">
			<p className="text-sm text-muted-light">{label}</p>
			<p className="text-3xl font-bold font-mono mt-1">{value}</p>
		</div>
	);
}

// --- Data Table ---

export function DataTable({
	headers,
	children,
}: {
	headers: string[];
	children: ReactNode;
}) {
	return (
		<div className="overflow-x-auto">
			<table className="w-full text-sm text-left">
				<thead className="text-xs font-tight uppercase tracking-wider text-muted border-b border-border/30">
					<tr>
						{headers.map((h) => (
							<th key={h} className="px-4 py-3">
								{h}
							</th>
						))}
					</tr>
				</thead>
				<tbody className="font-mono">{children}</tbody>
			</table>
		</div>
	);
}

export function DataRow({
	children,
	onClick,
}: {
	children: ReactNode;
	onClick?: () => void;
}) {
	return (
		<tr
			className={`border-b border-border/30 hover:bg-surface-3/50 transition-colors ${onClick ? "cursor-pointer" : ""}`}
			onClick={onClick}
		>
			{children}
		</tr>
	);
}

// --- Loading State ---

export function LoadingState() {
	return (
		<div className="py-20 text-center">
			<span className="font-mono text-muted animate-pulse">loading...</span>
		</div>
	);
}

// --- Error State ---

export function ErrorState({ message }: { message: string }) {
	return (
		<div className="bg-status-red/10 rounded-md p-4">
			<p className="font-mono text-sm text-status-red">{message}</p>
		</div>
	);
}

// --- Page Header ---

export function PageHeader({ children }: { children: ReactNode }) {
	return <h2 className="text-xl font-tight font-semibold mb-6">{children}</h2>;
}

// --- Back Link ---

export function BackLink({
	href,
	label,
	onClick,
}: {
	href?: string;
	label: string;
	onClick?: () => void;
}) {
	if (onClick) {
		return (
			<button
				onClick={onClick}
				className="font-mono text-sm text-muted hover:text-accent transition-colors mb-4 inline-block"
			>
				&larr; {label}
			</button>
		);
	}
	return (
		<a
			href={href}
			className="font-mono text-sm text-muted hover:text-accent transition-colors mb-4 inline-block"
		>
			&larr; {label}
		</a>
	);
}

// --- Action Button ---

const ACTION_VARIANTS: Record<string, string> = {
	danger: "text-status-red hover:bg-status-red/10",
	warning: "text-status-yellow hover:bg-status-yellow/10",
	info: "text-status-blue hover:bg-status-blue/10",
};

export function ActionButton({
	label,
	variant,
	onClick,
}: {
	label: string;
	variant: "danger" | "warning" | "info";
	onClick: () => void;
}) {
	return (
		<button
			onClick={(e) => {
				e.stopPropagation();
				onClick();
			}}
			className={`px-2 py-1 text-xs font-mono lowercase rounded-sm transition-colors ${ACTION_VARIANTS[variant]}`}
		>
			{label}
		</button>
	);
}
