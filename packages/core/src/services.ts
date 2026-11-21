import { join } from "node:path";
import { type CoreInfo, ProjectsFile, SettingsFile } from "@dark-matter/contracts";
import type { CoreServices } from "@dark-matter/contracts/router";
import { ActivityLog } from "./activity";
import { openCache } from "./cache";
import type { EventBus } from "./events";
import { agentCards, inboxFrom } from "./inbox";
import { log } from "./log";
import { OwnedFile } from "./owned-file";
import { projectServices, waitingSuggestions } from "./projects";
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
  const projects = await OwnedFile.open("projects.json", join(libraryHome, "projects.json"), ProjectsFile);
  const ownedFiles = [settings, projects];
  const ownedFileChanged = () =>
    bus.publish({ type: "invalidate", domains: ["settings", "ownedFiles", "inbox", "project"] });
  const env = { home };
  const scans = new Scans({
    env,
    cache,
    activity,
    projectPaths: () => Object.keys(projects.value.projects),
    exclude: [libraryHome],
    onChange: () => bus.publish({ type: "invalidate", domains: ["scan", "inbox", "agents", "project"] }),
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
      list: () =>
        inboxFrom(
          scans.latest,
          settings.value.ignoredFindings,
          env,
          waitingSuggestions(scans.latest?.suggestedProjects ?? [], projects.value, settings.value).suggested.length,
        ),
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
    project: projectServices({ env, projects, settings, activity, scans, bus }),
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
