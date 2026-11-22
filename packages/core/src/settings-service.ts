import type { ClientKind, SettingsFile } from "@dark-matter/contracts";
import type { CoreServices } from "@dark-matter/contracts/router";
import type { ActivityLog } from "./activity";
import type { Clock } from "./clock";
import type { EventBus } from "./events";
import type { OwnedFile } from "./owned-file";

export interface SettingsServiceOptions {
  settings: OwnedFile<typeof SettingsFile>;
  activity: ActivityLog;
  clock: Clock;
  bus: EventBus;
  /** After preferences are saved: the scheduler re-checks its time, the Activity Log its retention. */
  onPreferencesSaved(): Promise<void>;
}

/** `settings.json`'s own procedures (review #22): preferences, the First run, and ignored Inbox findings. */
export const settingsServices = ({
  settings,
  activity,
  clock,
  bus,
  onPreferencesSaved,
}: SettingsServiceOptions): {
  settings: CoreServices["settings"];
  findings: Pick<CoreServices["inbox"], "ignore" | "unignore">;
} => {
  /** Ignoring or Un-ignoring an Inbox finding edits `ignoredFindings` (kept sorted). */
  const ignored =
    (action: "inbox.ignore" | "inbox.unignore", edit: (current: string[], id: string) => string[]) =>
    (id: string, client: ClientKind) =>
      activity.track({ client, action, subjects: [{ kind: "finding", id }] }, async (wrote) => {
        wrote(await settings.update((current) => ({ ...current, ignoredFindings: edit(current.ignoredFindings, id) })));
        bus.invalidate("settings", "inbox");
      });
  /**
   * Saves an Adopt Permission or the Agent Config Guard (ADR-0007). What can be
   * adopted changes with it, so every view of the Scan's findings is refreshed.
   */
  const saveAdoptGate = (
    client: ClientKind,
    action: "settings.setAdoptPermission" | "settings.setAgentConfigGuard",
    id: string,
    edit: (preferences: SettingsFile["preferences"]) => SettingsFile["preferences"],
  ) =>
    activity.track({ client, action, subjects: [{ kind: "settings", id }] }, async (wrote) => {
      wrote(await settings.update((current) => ({ ...current, preferences: edit(current.preferences) })));
      bus.invalidate("settings", "inbox", "scan", "agents", "project");
      return settings.value;
    });
  return {
    settings: {
      get: () => settings.value,
      updatePreferences: async (patch, client) => {
        const saved = await activity.track(
          { client, action: "settings.updatePreferences", subjects: [{ kind: "settings", id: "preferences" }] },
          async (wrote) => {
            wrote(
              await settings.update((current) => ({ ...current, preferences: { ...current.preferences, ...patch } })),
            );
            bus.invalidate("settings", "scheduler");
            return settings.value;
          },
        );
        await onPreferencesSaved();
        return saved;
      },
      setAdoptPermission: ({ agent, kind, allowed }, client) =>
        saveAdoptGate(client, "settings.setAdoptPermission", "adoptPermissions", (preferences) => ({
          ...preferences,
          adoptPermissions: {
            ...preferences.adoptPermissions,
            [agent]: { ...preferences.adoptPermissions[agent], [kind]: allowed },
          },
        })),
      setAgentConfigGuard: ({ on }, client) =>
        saveAdoptGate(client, "settings.setAgentConfigGuard", "agentConfigGuard", (preferences) => ({
          ...preferences,
          agentConfigGuard: on,
        })),
      completeFirstRun: (client) =>
        activity.track(
          { client, action: "settings.completeFirstRun", subjects: [{ kind: "settings", id: "firstRun" }] },
          async (wrote) => {
            const completedAt = clock.now().toISOString();
            wrote(await settings.update((current) => ({ ...current, firstRun: current.firstRun ?? { completedAt } })));
            bus.invalidate("settings");
            return settings.value;
          },
        ),
    },
    findings: {
      ignore: ignored("inbox.ignore", (current, id) => [...new Set([...current, id])].sort()),
      unignore: ignored("inbox.unignore", (current, id) => current.filter((found) => found !== id)),
    },
  };
};
