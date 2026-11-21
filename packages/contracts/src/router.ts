import { initTRPC } from "@trpc/server";
import { z } from "zod";
import { isTaggedError } from "./errors";
import {
  ActivityExport,
  ActivityFilter,
  ActivityList,
  ActivityQuery,
  AddProjectSkills,
  AdoptInput,
  AdoptPlan,
  AgentCard,
  AgentId,
  ApplyAdoptInput,
  ApplyMcpAdoptInput,
  ApplyRenameNamespaceInput,
  type ClientKind,
  CopyDiff,
  type CoreEvent,
  CoreInfo,
  type CoreNotification,
  FulfilLockInput,
  Inbox,
  LibraryList,
  LibraryMcpList,
  McpAdoptInput,
  McpAdoptPlan,
  McpServerName,
  OffScope,
  OwnedFileName,
  OwnedFileProblem,
  PreferencesPatch,
  ProjectDetail,
  ProjectPath,
  ProjectSkill,
  ProjectSkillChange,
  ProjectSkillRef,
  ProjectSkills,
  ProjectSummary,
  RenameNamespaceInput,
  RenameNamespacePlan,
  RepoSkills,
  SavedSkillFile,
  SaveSkillFileInput,
  ScanResult,
  ScanStatus,
  SchedulerStatus,
  SettingsFile,
  SkillDeletePlan,
  SkillDetail,
  SkillFileContent,
  SkillFilePath,
  SkillFiles,
  SkillProjectUse,
  SuggestedProjects,
} from "./schemas";

/** Per-connection context, built once when a connection authenticates. */
export interface CoreContext {
  client: ClientKind;
}

/**
 * Everything the router needs from the core. The core implements this; the
 * router only validates, routes and maps errors, so it can live here and give
 * every client the `AppRouter` type without depending on the core.
 */
export interface CoreServices {
  info(): CoreInfo;
  library: {
    list(): Promise<LibraryList>;
  };
  settings: {
    get(): SettingsFile;
    updatePreferences(patch: PreferencesPatch, client: ClientKind): Promise<SettingsFile>;
  };
  ownedFiles: {
    /** Hand edits the core is holding because they don't validate. */
    problems(): OwnedFileProblem[];
    /** Overwrites a held hand edit with the last good state. */
    discard(file: OwnedFileName, client: ClientKind): Promise<void>;
  };
  activity: {
    list(query: ActivityQuery): ActivityList;
    /** Every entry matching the filter, for saving as JSON. Not recorded, like any view. */
    export(filter: ActivityFilter): ActivityExport;
  };
  scan: {
    /** Runs a read-only Scan, or joins the one already running. */
    run(client: ClientKind): Promise<ScanResult>;
    status(): ScanStatus;
  };
  inbox: {
    list(): Inbox;
    /** Leaves a finding alone from now on (recorded in `settings.json`). */
    ignore(id: string, client: ClientKind): Promise<void>;
  };
  agents: {
    list(): AgentCard[];
  };
  managedSkills: {
    /**
     * "Turn off everywhere": turns an Agent-managed Skill off through its Agent's
     * own global settings, with a targeted, format-preserving edit.
     */
    turnOff(input: { id: string; scope: OffScope }, client: ClientKind): Promise<void>;
  };
  adopt: {
    /** The dry run: what Adopting these findings would do. Writes nothing. */
    plan(input: AdoptInput): Promise<AdoptPlan>;
    /** Re-plans, checks the plan id still matches, then applies it. */
    apply(input: ApplyAdoptInput, client: ClientKind): Promise<AdoptPlan>;
    /** Undo Adopt: moves the Skill back to where it was Adopted from and puts back what Adopt removed. */
    undo(key: string, client: ClientKind): Promise<void>;
  };
  scheduler: {
    status(): SchedulerStatus;
  };
  mcp: {
    /** Library MCP Servers, by name. */
    list(): Promise<LibraryMcpList>;
    /** The dry run for Adopting Global MCP Servers. Writes nothing. */
    adoptPlan(input: McpAdoptInput): Promise<McpAdoptPlan>;
    /** Re-plans, checks the plan id still matches, then applies it. */
    adoptExecute(input: ApplyMcpAdoptInput, client: ClientKind): Promise<McpAdoptPlan>;
    /** Undo Adopt: puts every entry it came from back into its Agent config and removes it from the Library. */
    undoAdopt(name: string, client: ClientKind): Promise<void>;
  };
  skill: {
    /** A Library Skill's page: SKILL.md split into frontmatter and body, warnings and its Library Lock entry. */
    get(key: string): Promise<SkillDetail>;
    /** The Skill's file tree for the Files tab. */
    files(key: string): Promise<SkillFiles>;
    readFile(input: SkillFilePath): Promise<SkillFileContent>;
    /** Saves one file atomically, exactly as given (SKILL.md is never rewritten). Frontmatter problems are warnings. */
    saveFile(input: SaveSkillFileInput, client: ClientKind): Promise<SavedSkillFile>;
    /** Deleting's dry run: the trash retention and the Projects whose Links would break or Copies stay behind. */
    deletePlan(key: string): Promise<SkillDeletePlan>;
    /** Moves the Skill into `trash/` (purged after the configured days) and drops it from the Library Lock. */
    delete(key: string, client: ClientKind): Promise<void>;
  };
  namespace: {
    /** Rename Namespace's dry run. Writes nothing. */
    plan(input: RenameNamespaceInput): Promise<RenameNamespacePlan>;
    /** Re-plans, checks the plan id, then moves the folders, re-keys the Library Lock and re-creates Links. */
    rename(input: ApplyRenameNamespaceInput, client: ClientKind): Promise<RenameNamespacePlan>;
  };
  /** OS notifications for the app to show, from now on, until `signal` aborts. */
  notifications(signal: AbortSignal): AsyncIterable<CoreNotification>;
  project: {
    /** Suggested Projects from the last Scan, minus confirmed and dismissed ones. */
    suggested(): SuggestedProjects;
    list(): Promise<ProjectSummary[]>;
    get(path: string): Promise<ProjectDetail>;
    /**
     * Confirms a Suggested Project or adds a folder by hand: the git toplevel
     * of `path`, or `path` itself without git. Agents default to the detected ones.
     */
    add(input: { path: string; agents?: AgentId[] | undefined }, client: ClientKind): Promise<ProjectDetail>;
    dismiss(path: string, client: ClientKind): Promise<void>;
    setAgents(input: { path: string; agents: AgentId[] }, client: ClientKind): Promise<ProjectDetail>;
    /** Points a Project at the folder it moved to. */
    locate(input: { path: string; newPath: string }, client: ClientKind): Promise<ProjectDetail>;
    /** Forgets a Project. Nothing on disk changes. */
    remove(path: string, client: ClientKind): Promise<void>;
    /** Its Project Skills, with their delivery status. */
    skills(path: string): Promise<ProjectSkill[]>;
    /** Every Project using a Library Skill (the Skill page's Projects tab). */
    forSkill(key: string): Promise<SkillProjectUse[]>;
    /** Adds Library Skills to Projects (Link by default) and delivers them On. Re-adding one turns it On. */
    addSkills(input: AddProjectSkills, client: ClientKind): Promise<ProjectSkills[]>;
    /** On re-delivers a Project Skill; Off removes its delivery but keeps it in `projects.json`. */
    setSkillOn(input: ProjectSkillChange & { on: boolean }, client: ClientKind): Promise<ProjectSkills>;
    /** Removes a Project Skill: its delivery goes and the Project forgets it. */
    removeSkill(input: ProjectSkillChange, client: ClientKind): Promise<ProjectSkills>;
    /** Replaces an On Copy's files and lock entry with the Library's version (Update, Take Library version). */
    updateCopy(input: ProjectSkillChange, client: ClientKind): Promise<ProjectSkills>;
    /** A Copy's edits against the Library. */
    copyDiff(input: ProjectSkillRef): Promise<CopyDiff>;
    /** Copies a Copy's files into its Library Skill (marked Modified when it has a Source); other Copies become outdated. */
    pullCopy(input: ProjectSkillRef, client: ClientKind): Promise<ProjectSkills>;
    /** Committed Skills it didn't create (Vendored) and `skills-lock.json` entries waiting to be fulfilled. Read-only. */
    repoSkills(path: string): Promise<RepoSkills>;
    /** Makes `skills-lock.json` entries Copies of their Library Skills; a committed folder is kept as is. */
    fulfilLock(input: FulfilLockInput, client: ClientKind): Promise<ProjectSkills>;
    /** Resolves a Name Conflict: `key` wins and the other same-name Project Skills are removed. */
    resolveConflict(input: ProjectSkillRef, client: ClientKind): Promise<ProjectSkills>;
  };
  /** Core events from now on, until `signal` aborts. */
  events(signal: AbortSignal): AsyncIterable<CoreEvent>;
}

const t = initTRPC.context<CoreContext>().create({
  errorFormatter({ shape, error }) {
    const tag = isTaggedError(error.cause) ? error.cause._tag : null;
    return { ...shape, data: { ...shape.data, tag } };
  },
});

export const createAppRouter = (services: CoreServices) =>
  t.router({
    core: t.router({
      info: t.procedure.output(CoreInfo).query(() => services.info()),
    }),
    library: t.router({
      list: t.procedure.output(LibraryList).query(() => services.library.list()),
    }),
    settings: t.router({
      get: t.procedure.output(SettingsFile).query(() => services.settings.get()),
      updatePreferences: t.procedure
        .input(PreferencesPatch)
        .output(SettingsFile)
        .mutation(({ input, ctx }) => services.settings.updatePreferences(input, ctx.client)),
    }),
    ownedFiles: t.router({
      problems: t.procedure.output(OwnedFileProblem.array()).query(() => services.ownedFiles.problems()),
      discard: t.procedure
        .input(z.object({ file: OwnedFileName }))
        .mutation(({ input, ctx }) => services.ownedFiles.discard(input.file, ctx.client)),
    }),
    activity: t.router({
      list: t.procedure
        .input(ActivityQuery)
        .output(ActivityList)
        .query(({ input }) => services.activity.list(input)),
      export: t.procedure
        .input(ActivityFilter)
        .output(ActivityExport)
        .query(({ input }) => services.activity.export(input)),
    }),
    scan: t.router({
      run: t.procedure.output(ScanResult).mutation(({ ctx }) => services.scan.run(ctx.client)),
      status: t.procedure.output(ScanStatus).query(() => services.scan.status()),
    }),
    inbox: t.router({
      list: t.procedure.output(Inbox).query(() => services.inbox.list()),
      ignore: t.procedure
        .input(z.object({ id: z.string().min(1) }))
        .mutation(({ input, ctx }) => services.inbox.ignore(input.id, ctx.client)),
    }),
    agents: t.router({
      list: t.procedure.output(AgentCard.array()).query(() => services.agents.list()),
    }),
    managedSkills: t.router({
      turnOff: t.procedure
        .input(z.object({ id: z.string().min(1), scope: OffScope }))
        .mutation(({ input, ctx }) => services.managedSkills.turnOff(input, ctx.client)),
    }),
    adopt: t.router({
      plan: t.procedure
        .input(AdoptInput)
        .output(AdoptPlan)
        .query(({ input }) => services.adopt.plan(input)),
      // `apply` is reserved by tRPC, so the procedure that applies a plan is `execute`.
      execute: t.procedure
        .input(ApplyAdoptInput)
        .output(AdoptPlan)
        .mutation(({ input, ctx }) => services.adopt.apply(input, ctx.client)),
      undo: t.procedure
        .input(z.object({ key: z.string().min(1) }))
        .mutation(({ input, ctx }) => services.adopt.undo(input.key, ctx.client)),
    }),
    mcp: t.router({
      list: t.procedure.output(LibraryMcpList).query(() => services.mcp.list()),
      adoptPlan: t.procedure
        .input(McpAdoptInput)
        .output(McpAdoptPlan)
        .query(({ input }) => services.mcp.adoptPlan(input)),
      adoptExecute: t.procedure
        .input(ApplyMcpAdoptInput)
        .output(McpAdoptPlan)
        .mutation(({ input, ctx }) => services.mcp.adoptExecute(input, ctx.client)),
      undoAdopt: t.procedure
        .input(z.object({ name: McpServerName }))
        .mutation(({ input, ctx }) => services.mcp.undoAdopt(input.name, ctx.client)),
    }),
    scheduler: t.router({
      status: t.procedure.output(SchedulerStatus).query(() => services.scheduler.status()),
    }),
    project: t.router({
      suggested: t.procedure.output(SuggestedProjects).query(() => services.project.suggested()),
      list: t.procedure.output(ProjectSummary.array()).query(() => services.project.list()),
      get: t.procedure
        .input(ProjectPath)
        .output(ProjectDetail)
        .query(({ input }) => services.project.get(input.path)),
      add: t.procedure
        .input(ProjectPath.extend({ agents: z.array(AgentId).min(1).optional() }))
        .output(ProjectDetail)
        .mutation(({ input, ctx }) => services.project.add(input, ctx.client)),
      dismiss: t.procedure
        .input(ProjectPath)
        .mutation(({ input, ctx }) => services.project.dismiss(input.path, ctx.client)),
      setAgents: t.procedure
        .input(ProjectPath.extend({ agents: z.array(AgentId).min(1) }))
        .output(ProjectDetail)
        .mutation(({ input, ctx }) => services.project.setAgents(input, ctx.client)),
      locate: t.procedure
        .input(ProjectPath.extend({ newPath: z.string().min(1) }))
        .output(ProjectDetail)
        .mutation(({ input, ctx }) => services.project.locate(input, ctx.client)),
      remove: t.procedure
        .input(ProjectPath)
        .mutation(({ input, ctx }) => services.project.remove(input.path, ctx.client)),
      skills: t.procedure
        .input(ProjectPath)
        .output(ProjectSkill.array())
        .query(({ input }) => services.project.skills(input.path)),
      forSkill: t.procedure
        .input(z.object({ key: z.string().min(1) }))
        .output(SkillProjectUse.array())
        .query(({ input }) => services.project.forSkill(input.key)),
      addSkills: t.procedure
        .input(AddProjectSkills)
        .output(ProjectSkills.array())
        .mutation(({ input, ctx }) => services.project.addSkills(input, ctx.client)),
      setSkillOn: t.procedure
        .input(ProjectSkillChange.extend({ on: z.boolean() }))
        .output(ProjectSkills)
        .mutation(({ input, ctx }) => services.project.setSkillOn(input, ctx.client)),
      removeSkill: t.procedure
        .input(ProjectSkillChange)
        .output(ProjectSkills)
        .mutation(({ input, ctx }) => services.project.removeSkill(input, ctx.client)),
      updateCopy: t.procedure
        .input(ProjectSkillChange)
        .output(ProjectSkills)
        .mutation(({ input, ctx }) => services.project.updateCopy(input, ctx.client)),
      copyDiff: t.procedure
        .input(ProjectSkillRef)
        .output(CopyDiff)
        .query(({ input }) => services.project.copyDiff(input)),
      pullCopy: t.procedure
        .input(ProjectSkillRef)
        .output(ProjectSkills)
        .mutation(({ input, ctx }) => services.project.pullCopy(input, ctx.client)),
      repoSkills: t.procedure
        .input(ProjectPath)
        .output(RepoSkills)
        .query(({ input }) => services.project.repoSkills(input.path)),
      fulfilLock: t.procedure
        .input(FulfilLockInput)
        .output(ProjectSkills)
        .mutation(({ input, ctx }) => services.project.fulfilLock(input, ctx.client)),
      resolveConflict: t.procedure
        .input(ProjectSkillRef)
        .output(ProjectSkills)
        .mutation(({ input, ctx }) => services.project.resolveConflict(input, ctx.client)),
    }),
    skill: t.router({
      get: t.procedure
        .input(z.object({ key: z.string().min(1) }))
        .output(SkillDetail)
        .query(({ input }) => services.skill.get(input.key)),
      files: t.procedure
        .input(z.object({ key: z.string().min(1) }))
        .output(SkillFiles)
        .query(({ input }) => services.skill.files(input.key)),
      readFile: t.procedure
        .input(SkillFilePath)
        .output(SkillFileContent)
        .query(({ input }) => services.skill.readFile(input)),
      saveFile: t.procedure
        .input(SaveSkillFileInput)
        .output(SavedSkillFile)
        .mutation(({ input, ctx }) => services.skill.saveFile(input, ctx.client)),
      deletePlan: t.procedure
        .input(z.object({ key: z.string().min(1) }))
        .output(SkillDeletePlan)
        .query(({ input }) => services.skill.deletePlan(input.key)),
      delete: t.procedure
        .input(z.object({ key: z.string().min(1) }))
        .mutation(({ input, ctx }) => services.skill.delete(input.key, ctx.client)),
    }),
    namespace: t.router({
      plan: t.procedure
        .input(RenameNamespaceInput)
        .output(RenameNamespacePlan)
        .query(({ input }) => services.namespace.plan(input)),
      rename: t.procedure
        .input(ApplyRenameNamespaceInput)
        .output(RenameNamespacePlan)
        .mutation(({ input, ctx }) => services.namespace.rename(input, ctx.client)),
    }),
    events: t.procedure.subscription(async function* ({ signal }) {
      yield* services.events(signal ?? new AbortController().signal);
    }),
    notifications: t.procedure.subscription(async function* ({ signal }) {
      yield* services.notifications(signal ?? new AbortController().signal);
    }),
  });

export type AppRouter = ReturnType<typeof createAppRouter>;
