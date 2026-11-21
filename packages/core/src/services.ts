import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type CoreInfo,
  type Inbox,
  LibraryLockFile,
  type ProjectDetail,
  ProjectNotFound,
  type ProjectRecord,
  ProjectsFile,
  type RequestRecord,
  RequestsFile,
  SettingsFile,
  UnknownFinding,
} from "@dark-matter/contracts";
import type { CoreServices } from "@dark-matter/contracts/router";
import { ActivityLog, retentionJob, type Wrote } from "./activity";
import { Adopt } from "./adopt";
import { agentAdapters } from "./agents";
import { openCache } from "./cache";
import type { Clock } from "./clock";
import { Collections } from "./collections";
import { editConfigFile } from "./config-edit";
import { Drift } from "./drift";
import type { EventBus } from "./events";
import { Favourites } from "./favourites";
import { GitHubAccess, type GitHubOptions } from "./github";
import { Importer, importerServices } from "./importer";
import { agentCards, ignoredInbox, inboxFrom } from "./inbox";
import { Library } from "./library";
import { startLiveRefresh } from "./live-refresh";
import { log } from "./log";
import { managedSkillRef } from "./managed-skills";
import { McpAdopt, McpLibrary } from "./mcp-library";
import { type KeyRenameHook, NamespaceRename } from "./namespace-rename";
import type { Notifier } from "./notifier";
import { OverviewService } from "./overview";
import { OwnedFile } from "./owned-file";
import { ProjectMcpService } from "./project-mcp";
import { ProjectSkillService } from "./project-skills";
import { projectServices, waitingSuggestions } from "./projects";
import type { LockImporter } from "./repo-skills";
import { type RequestApplier, Requests } from "./requests";
import { Scans } from "./scans";
import { scanJob } from "./scheduled-scan";
import { type DailyJob, Scheduler } from "./scheduler";
import type { SecretStore } from "./secrets";
import { SkillEditor } from "./skill-editor";
import { skillServices } from "./skill-page";
import { SkillsSh, type SkillsShOptions } from "./skills-sh";
import { SourceChecks } from "./source-check";
import { Trash } from "./trash";
import { untrackedSkills } from "./untracked";
import { Updates } from "./updates";

export interface ServicesOptions {
  libraryHome: string;
  /** `$HOME`, for writing paths home-relative. */
  home: string;
  info: () => CoreInfo;
  bus: EventBus;
  clock: Clock;
  /** Where system-wide Agent config is read from (`/` outside tests). */
  systemRoot?: string;
  notifier: Notifier;
  secrets: SecretStore;
  github: GitHubOptions;
  /** How long an Agent's call waits for Approve or Deny before it's told the Request is pending. */
  requestWaitMs: number;
  skillsSh: SkillsShOptions;
}

/** Pending Requests join the Inbox and its count (#44). */
const withRequests = (inbox: Omit<Inbox, "requests">, pending: RequestRecord[]): Inbox => ({
  ...inbox,
  requests: pending.map(({ input: _, ...request }) => request),
  count: inbox.count + pending.length,
});

/** The core's service methods behind the router (ADR-0003): every action is one of these. */
export const createServices = async ({
  libraryHome,
  home,
  info,
  bus,
  clock,
  notifier,
  secrets,
  github,
  skillsSh,
  systemRoot,
  requestWaitMs,
}: ServicesOptions) => {
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
  const requestsFile = await OwnedFile.open("requests.json", join(libraryHome, "requests.json"), RequestsFile);
  const requests = new Requests({
    file: requestsFile,
    projects,
    activity,
    clock,
    notifier,
    bus,
    waitMs: requestWaitMs,
  });
  await requests.expire();
  const stopExpiring = clock.every(
    60_000,
    () => void requests.expire().catch((error: unknown) => log(`expiring Requests: ${String(error)}`)),
  );
  const activityRetention = () => settings.value.preferences.activityRetention;
  await activity.prune(activityRetention());
  const library = new Library(libraryHome, home, libraryLock);
  const ownedFiles = [settings, projects, libraryLock, requestsFile];
  const ownedFileChanged = () =>
    bus.publish({
      type: "invalidate",
      domains: [
        "settings",
        "ownedFiles",
        "inbox",
        "project",
        "library",
        "skill",
        "collections",
        "favourites",
        "requests",
      ],
    });
  const env = { home, ...(systemRoot && { systemRoot }) };
  const scans = new Scans({
    env,
    cache,
    activity,
    projectPaths: () => Object.keys(projects.value.projects),
    exclude: [libraryHome],
    onChange: () => {
      bus.publish({ type: "invalidate", domains: ["scan", "inbox", "agents", "project", "scheduler"] });
      // After the first Scan, the Agents' folders are watched too.
      void liveRefresh?.sync();
    },
  });
  /** The daily run, in order. Later jobs (update checks, starred Sources) are added here. */
  const dailyJobs: DailyJob[] = [
    scanJob({ scans, settings, drift: () => drift.groups() }),
    retentionJob(activity, activityRetention),
  ];
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
    onChange: () => bus.publish({ type: "invalidate", domains: ["mcp", "inbox", "project", "collections"] }),
    projectFindings: () => projectMcp.findings(),
    keepPersonal: {
      keep: (path, name, wrote) => projectMcp.keepPersonal(path, name, wrote),
      release: (path, name, wrote) => projectMcp.release(path, name, wrote),
    },
  });
  /** What follows a Library Skill to a new key. Project Skills (Links and Copies) push their hook below. */
  const keyRenameHooks: KeyRenameHook[] = [];
  const namespaceRename = new NamespaceRename({
    home,
    library,
    activity,
    hooks: keyRenameHooks,
    onChange: () => bus.publish({ type: "invalidate", domains: ["library", "skill", "project", "collections"] }),
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
  /** GitHub Import (#30); it also Imports `skills-lock.json` entries missing from the Library while fulfilling them. */
  const importer = new Importer({
    home,
    libraryHome,
    library,
    activity,
    github: new GitHubAccess(github, secrets),
    onChange: (domains) => bus.publish({ type: "invalidate", domains }),
  });
  const lockImporter: LockImporter | null = importer.lockImporter();
  /** skills.sh search and Get (#31); Get Imports through `importer`. */
  const skillsShSearch = new SkillsSh({ ...skillsSh, clock, library, importer });
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
  const projectMcp = new ProjectMcpService({ home, mcp: mcpLibrary, secrets, projects, activity, bus });
  /** A changed record (e.g. Agents) re-delivers Project Skills, then Project MCP Servers. */
  const deliverProject = {
    deliver: async (path: string, next: ProjectRecord, wrote: Wrote) => {
      await projectSkills.deliver(path, next, wrote);
      await projectMcp.redeliver(path, wrote);
    },
    release: async (path: string, wrote: Wrote) => {
      const record = projects.value.projects[path];
      // A Project whose folder is gone has nothing left in it to remove; its Personal entries elsewhere still go.
      const present = await stat(path).then(
        (info) => info.isDirectory(),
        () => false,
      );
      if (record && present) await projectSkills.forget(path, Object.keys(record.skills), wrote);
      await projectMcp.forgetAll(path, wrote).catch((error: unknown) => {
        if (present) throw error;
        log(`removing ${path}'s Personal MCP entries: ${String(error)}`);
      });
    },
  };
  // Learns where Copies are, so untracked Skills (#29) leave them out.
  void projectSkills.usage().catch(() => {});
  /** The Projects a Library Skill is in, for deleting it or undoing its Adopt. */
  const skillImpact = async (key: string) =>
    (await projectSkills.services().forSkill(key)).map(({ path, projectName, mode, on }) => ({
      path,
      projectName,
      mode,
      on,
    }));
  const adopt = new Adopt({
    home,
    library,
    activity,
    latestScan: () => scans.latest,
    rescan: () => scans.refresh(),
    onChange: () => bus.publish({ type: "invalidate", domains: ["library", "inbox", "skill"] }),
    untracked: () => findUntracked().flatMap((group) => group.findings),
    keepLinks: projectSkills.keepLinks(),
    usage: skillImpact,
    release: (key, wrote) => projectSkills.forgetEverywhere([key], wrote),
  });
  const trash = new Trash({
    library,
    activity,
    clock,
    retentionDays: () => settings.value.preferences.trashRetentionDays,
    usage: skillImpact,
    release: (key, wrote) => projectSkills.forgetEverywhere([key], wrote),
    onChange: () =>
      bus.publish({ type: "invalidate", domains: ["library", "skill", "inbox", "project", "collections"] }),
  });
  dailyJobs.push(trash.job());
  /** Updates for Imported Skills (#33); `sourceChecks` is the per-Source check #35 reuses for starred Sources. */
  const sourceChecks = new SourceChecks(cache, clock);
  /** Favourites (#35): starred Skills and Sources; starred Sources are checked with the update check. */
  const favourites = new Favourites({
    settings,
    library,
    activity,
    checks: sourceChecks,
    cache,
    clock,
    librarySkills: async () => library.list(await projectSkills.usage()),
    onChange: () => bus.publish({ type: "invalidate", domains: ["favourites", "settings", "inbox"] }),
  });
  // Before the Collections hook, which claims every settings.json step.
  keyRenameHooks.unshift(favourites.keyRenameHook(home));
  const updates = new Updates({
    home,
    library,
    importer,
    activity,
    checks: sourceChecks,
    cache,
    clock,
    trash,
    hooks: keyRenameHooks,
    starred: favourites.starredSourceCheck(),
    onChange: () =>
      bus.publish({
        type: "invalidate",
        domains: ["importer", "library", "skill", "project", "collections", "favourites"],
      }),
  });
  dailyJobs.push(updates.job());
  const projectProcedures = projectServices({ env, projects, settings, activity, scans, bus, deliver: deliverProject });
  const withGrant = (detail: ProjectDetail): ProjectDetail => ({
    ...detail,
    grant: projects.value.projects[detail.path]?.grant === true,
  });
  const drift = new Drift({
    home,
    libraryHome,
    library,
    projects,
    projectSkills,
    activity,
    bus,
    importer: () => lockImporter,
    removeProject: (path, client) => projectProcedures.remove(path, client),
    fulfilLock: (input, client) => projectSkills.services().fulfilLock(input, client),
  });
  // Live refresh (#42): owned files, MCP definitions, the Library, Projects and Agent folders.
  await mcpLibrary.all();
  let liveRefresh: Awaited<ReturnType<typeof startLiveRefresh>> | null = null;
  liveRefresh = await startLiveRefresh({
    env,
    libraryHome,
    ownedFiles,
    onOwnedFileChanged: ownedFileChanged,
    reloadMcp: async () => void (await mcpLibrary.all()),
    projectPaths: () => Object.keys(projects.value.projects),
    scanned: () => scans.latest !== null,
    rescan: () =>
      void scans.refresh().catch((error: unknown) => log(`re-Scan after a change failed: ${String(error)}`)),
    bus,
    clock,
    onError: (error) => log(`watching folders: ${String(error)}`),
  });
  const collections = new Collections({
    settings,
    library,
    activity,
    mcp: mcpLibrary,
    projectSkills,
    projectMcp,
    onChange: () => bus.publish({ type: "invalidate", domains: ["collections", "settings"] }),
  });
  keyRenameHooks.push(collections.keyRenameHook(home));
  const listInbox = async (ignored = settings.value.ignoredFindings) =>
    withRequests(
      inboxFrom(
        scans.latest,
        ignored,
        env,
        waitingSuggestions(scans.latest?.suggestedProjects ?? [], projects.value, settings.value).suggested.length,
        findUntracked(),
        await drift.groups(),
        favourites.inboxGroups(),
      ),
      requests.pending(),
    );
  const overview = new OverviewService({
    home,
    cache,
    now: () => clock.now(),
    latestScan: () => scans.latest,
    inbox: () => listInbox(),
    projectPaths: () => Object.keys(projects.value.projects),
    projectSkills: (path) => projectSkills.services().skills(path),
    libraryUpdates: async () => (await updates.view()).updates.length,
  });

  const services: Omit<CoreServices, "events" | "notifications"> = {
    consent: (call, next) => requests.consent(call, next),
    requests: {
      list: () => requests.list(),
      get: (id) => requests.get(id),
      approve: (id, client) => requests.approve(id, client),
      deny: (id, client) => requests.deny(id, client),
    },
    info,
    library: { list: async () => ({ skills: await library.list(await projectSkills.usage()) }) },
    settings: {
      get: () => settings.value,
      updatePreferences: async (patch, client) => {
        const saved = await activity.track(
          { client, action: "settings.updatePreferences", subjects: [{ kind: "settings", id: "preferences" }] },
          async (wrote) => {
            wrote(
              await settings.update((current) => ({ ...current, preferences: { ...current.preferences, ...patch } })),
            );
            bus.publish({ type: "invalidate", domains: ["settings", "scheduler"] });
            scheduler.check();
            return settings.value;
          },
        );
        await activity.prune(activityRetention());
        return saved;
      },
      completeFirstRun: (client) =>
        activity.track(
          { client, action: "settings.completeFirstRun", subjects: [{ kind: "settings", id: "firstRun" }] },
          async (wrote) => {
            const completedAt = clock.now().toISOString();
            wrote(await settings.update((current) => ({ ...current, firstRun: current.firstRun ?? { completedAt } })));
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
    activity: { list: (query) => activity.list(query), export: (filter) => activity.export(filter) },
    scan: {
      // After the first Scan the Agents' folders are watched before the call returns, so no change is missed.
      run: async (client) => {
        const result = await scans.run(client);
        await liveRefresh?.sync();
        return result;
      },
      status: () => scans.status(),
    },
    inbox: {
      list: () => listInbox(),
      ignored: async () => ignoredInbox(await listInbox([]), settings.value.ignoredFindings),
      unignore: (id, client) =>
        activity.track({ client, action: "inbox.unignore", subjects: [{ kind: "finding", id }] }, async (wrote) => {
          wrote(
            await settings.update((current) => ({
              ...current,
              ignoredFindings: current.ignoredFindings.filter((ignored) => ignored !== id),
            })),
          );
          bus.publish({ type: "invalidate", domains: ["settings", "inbox"] });
        }),
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
    overview: { get: () => overview.get() },
    drift: {
      restore: (id, client) => drift.restore(id, client),
      accept: (id, client) => drift.accept(id, client),
    },
    agents: {
      list: () => agentCards(scans.latest, env),
      managedMcp: () => scans.latest?.managedMcpServers ?? [],
    },
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
    managedMcp: {
      turnOff: ({ id, scope }, client) =>
        activity.track({ client, action: "managedMcp.turnOff", subjects: [{ kind: "finding", id }] }, async (wrote) => {
          const server = scans.latest?.managedMcpServers.find((found) => found.id === id);
          const off = agentAdapters.find((adapter) => adapter.id === server?.agent)?.managedMcp?.off;
          if (!server || !off || !server.offSwitches.some((offSwitch) => offSwitch.scope === scope)) {
            throw new UnknownFinding(id);
          }
          const written = await editConfigFile(off.file(env), (text) => off.turnOff(text, server, scope));
          if (written) wrote(written);
          await scans.refresh();
        }),
    },
    adopt: {
      plan: ({ findings }) => adopt.plan(findings),
      apply: ({ findings, planId }, client) => adopt.apply(findings, planId, client),
      undoPlan: (key) => adopt.undoPlan(key),
      undo: (key, client) => adopt.undo(key, client),
    },
    mcp: {
      list: async () => ({ servers: await mcpLibrary.list(home, secrets) }),
      adoptPlan: ({ findings, names }) => mcpAdopt.plan(findings, names),
      adoptExecute: ({ findings, names, planId }, client) => mcpAdopt.apply(findings, names, planId, client),
      undoAdopt: (name, client) => mcpAdopt.undo(name, client),
      ...projectMcp.mcpServices(),
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
      ...projectProcedures,
      // The new folder is watched before the call returns, so no change to it is missed.
      add: async (input, client) => {
        const detail = await projectProcedures.add(input, client);
        await liveRefresh?.sync();
        return detail;
      },
      locate: async (input, client) => {
        const detail = await projectProcedures.locate(input, client);
        await liveRefresh?.sync();
        return detail;
      },
      ...projectSkills.services(),
      ...projectMcp.services(),
      get: async (path) => withGrant(await projectProcedures.get(path)),
      removePlan: async (path) => ({
        path,
        ...(await projectSkills.releasePlan(path)),
        ...projectMcp.releasePlan(path),
      }),
      setGrant: ({ path, grant }, client) =>
        activity.track(
          {
            client,
            action: grant ? "project.grant" : "project.revokeGrant",
            subjects: [{ kind: "project", id: path }],
          },
          async (wrote) => {
            if (!projects.value.projects[path]) throw new ProjectNotFound(path);
            wrote(
              await projects.update((current) => {
                const { grant: _, ...record } = current.projects[path] ?? {};
                return {
                  ...current,
                  projects: { ...current.projects, [path]: grant ? { ...record, grant: true } : record },
                };
              }),
            );
            bus.publish({ type: "invalidate", domains: ["project"] });
            return withGrant(await projectProcedures.get(path));
          },
        ),
    },
    collections: collections.services(),
    favourites: {
      get: () => favourites.get(),
      view: () => favourites.view(),
      setSkill: (input, client) => favourites.setSkill(input, client),
      setSource: (input, client) => favourites.setSource(input, client),
    },
    importer: {
      ...importerServices(importer),
      checkUpdates: (input, client) => updates.check(input, client),
      updates: () => updates.view(),
      updateDiff: (key) => updates.diff(key),
      applyUpdates: (input, client) => updates.apply(input, client),
      detach: (key, client) => updates.detach(key, client),
      repoint: (input, client) => updates.repoint(input, client),
    },
    skillsSh: {
      search: ({ query }) => skillsShSearch.search(query),
      get: ({ id }, client) => skillsShSearch.get(id, client),
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
    /** The server hands in how to call a mutation, for applying Requests approved after their call stopped waiting. */
    setRequestApplier: (applier: RequestApplier) => requests.setApplier(applier),
    close: async () => {
      stopExpiring();
      await liveRefresh?.close();
      await scheduler.stop();
      await scans.settle();
      cache.close();
    },
  };
};

export type Services = Awaited<ReturnType<typeof createServices>>;
