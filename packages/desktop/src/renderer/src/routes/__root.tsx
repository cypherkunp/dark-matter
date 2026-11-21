import { createRootRoute, Outlet } from "@tanstack/react-router";
import { CommandPalette } from "@/components/command-palette";
import { Header } from "@/components/header";
import { Sidebar } from "@/components/sidebar";
import { useCoreEvents } from "@/components/use-core-events";
import { useNativeNavigation } from "@/components/use-native-navigation";

export const Route = createRootRoute({ component: AppShell });

/** The native macOS shell: tinted sidebar tree, breadcrumb header, content pane. */
function AppShell() {
  const { connected } = useCoreEvents();
  useNativeNavigation();
  return (
    <div className="flex h-full">
      <Sidebar connected={connected} />
      <main className="flex min-w-0 flex-1 flex-col bg-background">
        <Header />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </main>
      <CommandPalette />
    </div>
  );
}
