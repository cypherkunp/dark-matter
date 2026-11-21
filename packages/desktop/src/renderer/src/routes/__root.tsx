import { createRootRoute, Outlet } from "@tanstack/react-router";
import { Header } from "@/components/header";
import { Sidebar } from "@/components/sidebar";
import { useCoreEvents } from "@/components/use-core-events";

export const Route = createRootRoute({ component: AppShell });

/** The native macOS shell: tinted sidebar tree, breadcrumb header, content pane. */
function AppShell() {
  const { connected } = useCoreEvents();
  return (
    <div className="flex h-full">
      <Sidebar connected={connected} />
      <main className="flex min-w-0 flex-1 flex-col bg-background">
        <Header />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
