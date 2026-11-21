import type { CoreConnection } from "@dark-matter/contracts";
import { createCoreClient } from "@dark-matter/contracts/client";
import { app, Menu, Notification, Tray } from "electron";
import { trayIcon } from "./tray-icon";

export interface ResidencyOptions {
  connection: () => Promise<CoreConnection>;
  /** Shows the window, creating it if it was closed, and opens `path` when given. */
  showWindow: (path?: string) => void;
  log: (message: string) => void;
}

/**
 * Keeps Dark Matter resident in the menu bar (ADR-0003) and does the native
 * things the core asks for: OS notifications, the Inbox badge on the tray and
 * the login item. Main is a core client like the renderer; the core decides,
 * main only shows.
 */
export const startResidency = ({ connection, showWindow, log }: ResidencyOptions) => {
  const tray = new Tray(trayIcon());
  tray.setToolTip("Dark Matter");
  const { trpc, close } = createCoreClient({ connection, client: "app" });
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Dark Matter", click: () => showWindow() },
      {
        label: "Scan now",
        click: () => void trpc.scan.run.mutate().catch((error: unknown) => log(`Scan failed: ${String(error)}`)),
      },
      { type: "separator" },
      { label: "Quit Dark Matter", role: "quit" },
    ]),
  );
  if (process.platform !== "darwin") tray.on("click", () => showWindow());

  // Notifications need to stay referenced until clicked, or they're collected.
  const shown = new Set<Notification>();

  const refreshBadge = async () => {
    const { count } = await trpc.inbox.list.query();
    if (process.platform === "darwin") tray.setTitle(count > 0 ? String(count) : "", { fontType: "monospacedDigit" });
    tray.setToolTip(count > 0 ? `Dark Matter · ${count} in the Inbox` : "Dark Matter");
  };

  const applyLoginItem = async () => {
    const { preferences } = await trpc.settings.get.query();
    // Only a packaged app registers itself: a development build would add the bare Electron binary.
    if (!app.isPackaged) return;
    if (app.getLoginItemSettings().openAtLogin !== preferences.startAtLogin) {
      app.setLoginItemSettings({ openAtLogin: preferences.startAtLogin });
    }
  };

  const report = (what: string) => (error: unknown) => log(`${what}: ${String(error)}`);

  trpc.events.subscribe(undefined, {
    onStarted: () => {
      void refreshBadge().catch(report("Inbox badge"));
      void applyLoginItem().catch(report("login item"));
    },
    onData: (event) => {
      if (event.domains.includes("inbox")) void refreshBadge().catch(report("Inbox badge"));
      if (event.domains.includes("settings")) void applyLoginItem().catch(report("login item"));
    },
    onError: report("core events"),
  });

  trpc.notifications.subscribe(undefined, {
    onData: ({ title, body, path }) => {
      if (!Notification.isSupported()) return;
      const notification = new Notification({ title, body });
      shown.add(notification);
      notification.on("click", () => {
        shown.delete(notification);
        showWindow(path);
      });
      notification.on("close", () => shown.delete(notification));
      notification.show();
    },
    onError: report("core notifications"),
  });

  return {
    stop: async () => {
      tray.destroy();
      await close();
    },
  };
};
