import { join } from "node:path";
import { type CoreInfo, SettingsFile } from "@dark-matter/contracts";
import type { CoreServices } from "@dark-matter/contracts/router";
import type { EventBus } from "./events";
import { OwnedFile } from "./owned-file";

export interface ServicesOptions {
  libraryHome: string;
  info: () => CoreInfo;
  bus: EventBus;
}

/** The core's service methods behind the router (ADR-0003): every action is one of these. */
export const createServices = async ({ libraryHome, info, bus }: ServicesOptions) => {
  const settings = await OwnedFile.open("settings.json", join(libraryHome, "settings.json"), SettingsFile);

  const services: Omit<CoreServices, "events"> = {
    info,
    library: { list: async () => ({ skills: [] }) },
    settings: {
      get: () => settings.value,
      updatePreferences: async (patch) => {
        await settings.update((current) => ({ ...current, preferences: { ...current.preferences, ...patch } }));
        bus.publish({ type: "invalidate", domains: ["settings"] });
        return settings.value;
      },
    },
    ownedFiles: {
      problems: () => [settings.problem].filter((problem) => problem !== null),
      discard: async () => {
        await settings.discard();
      },
    },
    activity: { list: () => ({ entries: [] }) },
  };
  return { services, close: async () => {} };
};
