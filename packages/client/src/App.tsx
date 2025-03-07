import "./index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "./components/app-sidebar";
import { TooltipProvider } from "./components/ui/tooltip";
import { Toaster } from "./components/ui/toaster";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import Chat from "./routes/chat";
import Settings from "./routes/settings";
import Home from "./routes/home";
import useVersion from "./hooks/use-version";
import { useEffect } from "react";
import { apiClient } from "./lib/api";
import { STALE_TIMES } from "./hooks/use-query-hooks";
import AgentCreatorRoute from "./routes/createAgent";
import AgentCreator from "./components/agent-creator";
import { LogViewer } from "./components/log-viewer";

// Create a query client with optimized settings
const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: STALE_TIMES.STANDARD,
			// Default to no polling unless specifically configured
			refetchInterval: false,
			// Make queries retry 3 times with exponential backoff
			retry: 3,
			retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
			// Refetch query on window focus
			refetchOnWindowFocus: true,
			// Enable refetch on reconnect
			refetchOnReconnect: true,
			// Fail queries that take too long
		},
		mutations: {
			// Default to 3 retries for mutations too
			retry: 3,
			retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
		},
	},
});

// Prefetch initial data with smarter error handling
const prefetchInitialData = async () => {
	try {
		// Prefetch agents (real-time data so shorter stale time)
		await queryClient.prefetchQuery({
			queryKey: ["agents"],
			queryFn: () => apiClient.getAgents(),
			staleTime: STALE_TIMES.FREQUENT,
		});
	} catch (error) {
		console.error("Error prefetching initial data:", error);
		// Don't throw, let the app continue loading with fallbacks
	}
};

// Execute prefetch immediately
prefetchInitialData();

function App() {
	useVersion();

	// Also prefetch when the component mounts (helps with HMR and refreshes)
	useEffect(() => {
		prefetchInitialData();
	}, []);

	return (
		<QueryClientProvider client={queryClient}>
			<div
				className="dark antialiased"
				style={{
					colorScheme: "dark",
				}}
			>
				<BrowserRouter>
					<TooltipProvider delayDuration={0}>
						<SidebarProvider>
							<AppSidebar />
							<SidebarInset>
								<div className="flex flex-1 flex-col gap-4 size-full container">
									<Routes>
										<Route path="/" element={<Home />} />
										<Route path="chat/:agentId" element={<Chat />} />
										<Route path="settings/:agentId" element={<Settings />} />
										<Route path="agents/new" element={<AgentCreatorRoute />} />
										<Route path="/create" element={<AgentCreator />} />
										<Route path="/logs" element={<LogViewer />} />
									</Routes>
								</div>
							</SidebarInset>
						</SidebarProvider>
						<Toaster />
					</TooltipProvider>
				</BrowserRouter>
			</div>
		</QueryClientProvider>
	);
}

export default App;
