import { useQuery } from "@tanstack/react-query";
import { createRootRoute, Navigate, Outlet, useLocation } from "@tanstack/react-router";
import { useEffect } from "react";
import { CommandPalette } from "@/components/command-palette";
import { Header } from "@/components/header";
import { Sidebar } from "@/components/sidebar";
import { useCoreEvents } from "@/components/use-core-events";
import { useNativeNavigation } from "@/components/use-native-navigation";
import { applyTheme } from "@/lib/theme";
import { useTRPC } from "@/lib/trpc";

export const Route = createRootRoute({ component: AppShell });

/** The native macOS shell: a dark chrome (sidebar tree, breadcrumb toolbar) holding one floating content panel. */
function AppShell() {
  const { connected } = useCoreEvents();
  useNativeNavigation();
  const trpc = useTRPC();
  const settings = useQuery(trpc.settings.get.queryOptions());
  const theme = settings.data?.preferences.theme;
  useEffect(() => {
    if (theme) applyTheme(theme);
  }, [theme]);
  const firstRunRoute = useLocation({ select: (location) => location.pathname === "/first-run" });
  // The First run (#46) comes before the Library, once: nothing renders until settings.json says whether it's done.
  if (!settings.data) return <div className="h-full bg-background" />;
  if (!settings.data.firstRun && !firstRunRoute) return <Navigate to="/first-run" search={{ step: "welcome" }} />;
  if (firstRunRoute)
    return (
      <main className="h-full overflow-y-auto bg-background">
        <Outlet />
      </main>
    );
  return (
    <div className="flex h-full bg-chrome">
      <Sidebar connected={connected} />
      <main className="flex min-w-0 flex-1 flex-col">
        <Header />
        <div
          data-testid="content-panel"
          className="mr-2 mb-2 min-h-0 flex-1 overflow-y-auto rounded-[18px] bg-background text-foreground"
        >
          <Outlet />
        </div>
      </main>
      <CommandPalette />
    </div>
  );
}
