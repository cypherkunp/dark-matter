import { join } from "node:path";
import { type CoreInfo, LibraryLockFile, ProjectsFile, SettingsFile, UnknownFinding } from "@dark-matter/contracts";
import type { CoreServices } from "@dark-matter/contracts/router";
import { ActivityLog } from "./activity";
import { Adopt } from "./adopt";
import { agentAdapters } from "./agents";
import { openCache } from "./cache";
import type { Clock } from "./clock";
import { editConfigFile } from "./config-edit";
import type { EventBus } from "./events";
import { agentCards, inboxFrom } from "./inbox";
import { Library } from "./library";
import { log } from "./log";
import { managedSkillRef } from "./managed-skills";
import { McpAdopt, McpLibrary } from "./mcp-library";
import { type KeyRenameHook, NamespaceRename } from "./namespace-rename";
import type { Notifier } from "./notifier";
import { OwnedFile } from "./owned-file";
import { ProjectSkillService } from "./project-skills";
import { projectServices, waitingSuggestions } from "./projects";
import type { LockImporter } from "./repo-skills";
import { Scans } from "./scans";
import { scanJob } from "./scheduled-scan";
import { type DailyJob, Scheduler } from "./scheduler";
import type { SecretStore } from "./secrets";
import { SkillEditor } from "./skill-editor";
import { skillServices } from "./skill-page";
import { Trash } from "./trash";
import { untrackedSkills } from "./untracked";
import { watchOwnedFiles } from "./watch-owned";

export interface ServicesOptions {
  libraryHome: string;
  /** `$HOME`, for writing paths home-relative. */
  home: string;
  info: () => CoreInfo;
  bus: EventBus;
  clock: Clock;
  notifier: Notifier;
  secrets: SecretStore;
}

/** The core's service methods behind the router (ADR-0003): every action is one of these. */
export const createServices = async ({ libraryHome, home, info, bus, clock, notifier, secrets }: ServicesOptions) => {
  const cache = await openCache(libraryHome);
  const activity = await ActivityLog.open({
    libraryHome,
    home,
    cache,
    onRecorded: () => bus.publish({ type: "invalidate", domains: ["activity"] }),
    now: () => clock.now(),
  });
  const settings = await OwnedFile.open("settings.json", join(libraryHome, "settings.json"), SettingsFile);
  const projects = await OwnedFile.open("projects.json", join(libraryHome, "projects.json"), ProjectsFile);
  const libraryLock = await OwnedFile.open(
    "library-lock.json",
    join(libraryHome, "library-lock.json"),
    LibraryLockFile,
  );
  const library = new Library(libraryHome, home, libraryLock);
  const ownedFiles = [settings, projects, libraryLock];
  const ownedFileChanged = () =>
    bus.publish({ type: "invalidate", domains: ["settings", "ownedFiles", "inbox", "project", "library", "skill"] });
  const env = { home };
  const scans = new Scans({
    env,
    cache,
    activity,
    projectPaths: () => Object.keys(projects.value.projects),
    exclude: [libraryHome],
    onChange: () => bus.publish({ type: "invalidate", domains: ["scan", "inbox", "agents", "project", "scheduler"] }),
  });
  /** The daily run, in order. Later jobs (update checks, starred Sources) are added here. */
  const dailyJobs: DailyJob[] = [scanJob(scans, () => settings.value.ignoredFindings)];
  const scheduler = new Scheduler({
    clock,
    notifier,
    jobs: dailyJobs,
    time: () => settings.value.preferences.scheduledScanTime,
    lastRun: () => {
      const scheduled = activity.latest({ client: "scheduled-scan" });
      if (scheduled) return { at: scheduled, scheduled: true };
      const scanned = activity.latest({ action: "scan.run" });
      return scanned && { at: scanned, scheduled: false };
    },
    onChange: () => bus.publish({ type: "invalidate", domains: ["scheduler"] }),
  });
  const mcpLibrary = new McpLibrary(libraryHome);
  const mcpAdopt = new McpAdopt({
    home,
    libraryHome,
    mcp: mcpLibrary,
    secrets,
    activity,
    latestScan: () => scans.latest,
    rescan: () => scans.refresh(),
    onChange: () => bus.publish({ type: "invalidate", domains: ["mcp", "inbox"] }),
  });
  /** What follows a Library Skill to a new key. Project Skills (Links and Copies) push their hook below. */
  const keyRenameHooks: KeyRenameHook[] = [];
  const namespaceRename = new NamespaceRename({
    home,
    library,
    activity,
    hooks: keyRenameHooks,
    onChange: () => bus.publish({ type: "invalidate", domains: ["library", "skill", "project"] }),
  });
  const skillEditor = new SkillEditor({
    library,
    activity,
    onChange: () => bus.publish({ type: "invalidate", domains: ["library", "skill"] }),
  });
  /** Untracked Project Skills (#29) from the latest Scan; a Copy (#28) not yet committed isn't one. */
  const findUntracked = () =>
    untrackedSkills(scans.latest, env, libraryHome, [
      ...Object.values(libraryLock.value.skills).flatMap((entry) =>
        entry.localSource ? [library.absolute(entry.localSource)] : [],
      ),
      ...projectSkills.copyFolders(),
    ]);
  /** Imports a `skills-lock.json` entry missing from the Library while fulfilling it. GitHub Import (#30) sets it. */
  const lockImporter: LockImporter | null = null;
  const projectSkills = new ProjectSkillService({
    home,
    libraryHome,
    library,
    projects,
    activity,
    bus,
    importer: () => lockImporter,
  });
  keyRenameHooks.push(projectSkills.keyRenameHook());
  // Learns where Copies are, so untracked Skills (#29) leave them out.
  void projectSkills.usage().catch(() => {});
  const adopt = new Adopt({
    home,
    library,
    activity,
    latestScan: () => scans.latest,
    rescan: () => scans.refresh(),
    onChange: () => bus.publish({ type: "invalidate", domains: ["library", "inbox", "skill"] }),
    untracked: () => findUntracked().flatMap((group) => group.findings),
    keepLinks: projectSkills.keepLinks(),
  });
  const trash = new Trash({
    library,
    activity,
    clock,
    retentionDays: () => settings.value.preferences.trashRetentionDays,
    usage: async (key) =>
      (await projectSkills.services().forSkill(key)).map(({ path, projectName, mode, on }) => ({
        path,
        projectName,
        mode,
        on,
      })),
    onChange: () => bus.publish({ type: "invalidate", domains: ["library", "skill", "inbox", "project"] }),
  });
  dailyJobs.push(trash.job());
  const stopWatching = watchOwnedFiles(ownedFiles, ownedFileChanged, (error) =>
    log(`watching owned files: ${String(error)}`),
  );

  const services: Omit<CoreServices, "events" | "notifications"> = {
    info,
    library: { list: async () => ({ skills: await library.list(await projectSkills.usage()) }) },
    settings: {
      get: () => settings.value,
      updatePreferences: (patch, client) =>
        activity.track(
          { client, action: "settings.updatePreferences", subjects: [{ kind: "settings", id: "preferences" }] },
          async (wrote) => {
            wrote(
              await settings.update((current) => ({ ...current, preferences: { ...current.preferences, ...patch } })),
            );
            bus.publish({ type: "invalidate", domains: ["settings", "scheduler"] });
            scheduler.check();
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
          findUntracked(),
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
    adopt: {
      plan: ({ findings }) => adopt.plan(findings),
      apply: ({ findings, planId }, client) => adopt.apply(findings, planId, client),
      undo: (key, client) => adopt.undo(key, client),
    },
    mcp: {
      list: async () => ({ servers: await mcpLibrary.list(home) }),
      adoptPlan: ({ findings, names }) => mcpAdopt.plan(findings, names),
      adoptExecute: ({ findings, names, planId }, client) => mcpAdopt.apply(findings, names, planId, client),
      undoAdopt: (name, client) => mcpAdopt.undo(name, client),
    },
    scheduler: { status: () => scheduler.status() },
    skill: {
      ...skillServices(library),
      files: (key) => skillEditor.files(key),
      readFile: (input) => skillEditor.readFile(input),
      saveFile: (input, client) => skillEditor.saveFile(input, client),
      deletePlan: (key) => trash.plan(key),
      delete: (key, client) => trash.delete(key, client),
    },
    project: {
      ...projectServices({ env, projects, settings, activity, scans, bus, deliver: projectSkills }),
      ...projectSkills.services(),
    },
    namespace: {
      plan: (input) => namespaceRename.plan(input),
      rename: (input, client) => namespaceRename.rename(input, client),
    },
  };
  // A missed daily run Scans anyway, so it stands in for the catch-up Scan.
  if (!scheduler.due()) scans.catchUp();
  scheduler.start();

  return {
    services,
    close: async () => {
      stopWatching();
      await scheduler.stop();
      await scans.settle();
      cache.close();
    },
  };
};

export type Services = Awaited<ReturnType<typeof createServices>>;
