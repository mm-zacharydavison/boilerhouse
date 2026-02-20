import { useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { useHashRoute, matchRoute, useWebSocket } from "./hooks";
import { Overview } from "./pages/Overview";
import { WorkloadList } from "./pages/WorkloadList";
import { WorkloadDetail } from "./pages/WorkloadDetail";
import { InstanceList } from "./pages/InstanceList";
import { InstanceDetail } from "./pages/InstanceDetail";
import { TenantList } from "./pages/TenantList";
import { NodeList } from "./pages/NodeList";

const NAV_ITEMS = [
	{ path: "/", label: "Overview" },
	{ path: "/workloads", label: "Workloads" },
	{ path: "/instances", label: "Instances" },
	{ path: "/tenants", label: "Tenants" },
	{ path: "/nodes", label: "Nodes" },
] as const;

function App() {
	const [path, navigate] = useHashRoute();
	// Increment to force refetch on WS events
	const [tick, setTick] = useState(0);
	const refetch = useCallback(() => setTick((t) => t + 1), []);

	useWebSocket(() => {
		refetch();
	});

	let content: React.ReactNode;
	let params: Record<string, string> | null;

	if (path === "/") {
		content = <Overview key={tick} />;
	} else if (path === "/workloads") {
		content = <WorkloadList key={tick} navigate={navigate} />;
	} else if ((params = matchRoute(path, "/workloads/:name"))) {
		content = <WorkloadDetail key={`${params.name}-${tick}`} name={params.name!} navigate={navigate} />;
	} else if (path === "/instances") {
		content = <InstanceList key={tick} navigate={navigate} />;
	} else if ((params = matchRoute(path, "/instances/:id"))) {
		content = <InstanceDetail key={`${params.id}-${tick}`} id={params.id!} />;
	} else if (path === "/tenants") {
		content = <TenantList key={tick} />;
	} else if (path === "/nodes") {
		content = <NodeList key={tick} />;
	} else {
		content = (
			<div className="text-center py-20 text-gray-400">
				<h2 className="text-2xl font-semibold mb-2">Not Found</h2>
				<p>The page <code>{path}</code> does not exist.</p>
			</div>
		);
	}

	return (
		<div className="flex h-screen">
			{/* Sidebar */}
			<nav className="w-56 bg-gray-900 border-r border-gray-800 flex flex-col">
				<div className="px-4 py-5 border-b border-gray-800">
					<h1 className="text-lg font-bold tracking-tight text-white">Boilerhouse</h1>
				</div>
				<ul className="flex-1 py-2">
					{NAV_ITEMS.map((item) => {
						const active =
							item.path === "/"
								? path === "/"
								: path === item.path || path.startsWith(item.path + "/");
						return (
							<li key={item.path}>
								<a
									href={`#${item.path}`}
									className={`block px-4 py-2 text-sm transition-colors ${
										active
											? "bg-gray-800 text-white font-medium"
											: "text-gray-400 hover:text-white hover:bg-gray-800/50"
									}`}
								>
									{item.label}
								</a>
							</li>
						);
					})}
				</ul>
			</nav>

			{/* Main content */}
			<main className="flex-1 overflow-auto p-6">
				{content}
			</main>
		</div>
	);
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
