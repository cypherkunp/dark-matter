import { join } from "node:path";
import { type CoreInfo, SettingsFile, UnknownFinding } from "@dark-matter/contracts";
import type { CoreServices } from "@dark-matter/contracts/router";
import { ActivityLog } from "./activity";
import { agentAdapters } from "./agents";
import { openCache } from "./cache";
import { editConfigFile } from "./config-edit";
import type { EventBus } from "./events";
import { agentCards, inboxFrom } from "./inbox";
import { log } from "./log";
import { managedSkillRef } from "./managed-skills";
import { OwnedFile } from "./owned-file";
import { Scans } from "./scans";
import { watchOwnedFiles } from "./watch-owned";

export interface ServicesOptions {
  libraryHome: string;
  /** `$HOME`, for writing paths home-relative. */
  home: string;
  info: () => CoreInfo;
  bus: EventBus;
}

/** The core's service methods behind the router (ADR-0003): every action is one of these. */
export const createServices = async ({ libraryHome, home, info, bus }: ServicesOptions) => {
  const cache = await openCache(libraryHome);
  const activity = await ActivityLog.open({
    libraryHome,
    home,
    cache,
    onRecorded: () => bus.publish({ type: "invalidate", domains: ["activity"] }),
  });
  const settings = await OwnedFile.open("settings.json", join(libraryHome, "settings.json"), SettingsFile);
  const ownedFiles = [settings];
  const ownedFileChanged = () => bus.publish({ type: "invalidate", domains: ["settings", "ownedFiles", "inbox"] });
  const env = { home };
  const scans = new Scans({
    env,
    cache,
    activity,
    onChange: () => bus.publish({ type: "invalidate", domains: ["scan", "inbox", "agents"] }),
  });
  const stopWatching = watchOwnedFiles(ownedFiles, ownedFileChanged, (error) =>
    log(`watching owned files: ${String(error)}`),
  );

  const services: Omit<CoreServices, "events"> = {
    info,
    library: { list: async () => ({ skills: [] }) },
    settings: {
      get: () => settings.value,
      updatePreferences: (patch, client) =>
        activity.track(
          { client, action: "settings.updatePreferences", subjects: [{ kind: "settings", id: "preferences" }] },
          async (wrote) => {
            wrote(
              await settings.update((current) => ({ ...current, preferences: { ...current.preferences, ...patch } })),
            );
            bus.publish({ type: "invalidate", domains: ["settings"] });
            return settings.value;
          },
        ),
    },
    ownedFiles: {
      problems: () => ownedFiles.flatMap((file) => (file.problem ? [file.problem] : [])),
      discard: (name, client) =>
        activity.track(
          { client, action: "ownedFiles.discard", subjects: [{ kind: "settings", id: name }] },
          async (wrote) => {
            const file = ownedFiles.find((owned) => owned.name === name);
            if (file) wrote(await file.discard());
            ownedFileChanged();
          },
        ),
    },
    activity: { list: (query) => activity.list(query) },
    scan: {
      run: (client) => scans.run(client),
      status: () => scans.status(),
    },
    inbox: {
      list: () => inboxFrom(scans.latest, settings.value.ignoredFindings, env),
      ignore: (id, client) =>
        activity.track({ client, action: "inbox.ignore", subjects: [{ kind: "finding", id }] }, async (wrote) => {
          wrote(
            await settings.update((current) => ({
              ...current,
              ignoredFindings: [...new Set([...current.ignoredFindings, id])].sort(),
            })),
          );
          bus.publish({ type: "invalidate", domains: ["settings", "inbox"] });
        }),
    },
    agents: { list: () => agentCards(scans.latest, env) },
    managedSkills: {
      turnOff: ({ id, scope }, client) =>
        activity.track(
          { client, action: "managedSkills.turnOff", subjects: [{ kind: "finding", id }] },
          async (wrote) => {
            const skill = scans.latest?.managedSkills.find((found) => found.id === id);
            const off = agentAdapters.find((adapter) => adapter.id === skill?.agent)?.managed.off;
            if (!skill || !off || !skill.offSwitches.some((offSwitch) => offSwitch.scope === scope)) {
              throw new UnknownFinding(id);
            }
            const ref = managedSkillRef(skill, home);
            const file = await off.file(home);
            const written = await editConfigFile(file, (text) => off.turnOff(text, ref, scope));
            if (written) wrote(written);
            await scans.refresh();
          },
        ),
    },
  };
  scans.catchUp();

  return {
    services,
    close: async () => {
      stopWatching();
      await scans.settle();
      cache.close();
    },
  };
};

export type Services = Awaited<ReturnType<typeof createServices>>;
