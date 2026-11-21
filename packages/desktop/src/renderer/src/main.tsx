import { createCoreClient } from "@dark-matter/contracts/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createHashHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { followSystemTheme } from "./lib/theme";
import { TRPCProvider } from "./lib/trpc";
import { routeTree } from "./routeTree.gen";
import "./styles.css";

followSystemTheme();

// One connection to the core for the window's lifetime. It asks main where the
// core is on every (re)connect, so it follows a core that main restarted.
const { trpc } = createCoreClient({
  connection: () => window.darkMatter.coreConnection(),
  client: "app",
});

const queryClient = new QueryClient({
  defaultOptions: {
    // The core pushes invalidations over `events`, so cached data stays fresh.
    queries: { staleTime: Number.POSITIVE_INFINITY, refetchOnWindowFocus: false, retry: false },
  },
});

const router = createRouter({ routeTree, history: createHashHistory() });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpc} queryClient={queryClient}>
        <RouterProvider router={router} />
      </TRPCProvider>
    </QueryClientProvider>
  </StrictMode>,
);
