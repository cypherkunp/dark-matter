import { initTRPC } from "@trpc/server";
import { z } from "zod";
import { isTaggedError, RequestPending } from "./errors";
import {
  AppliedUpdates,
  ApplyUpdatesInput,
  CheckUpdatesInput,
  DetachResult,
  GitHubAuthStatus,
  ImportPreview,
  ImportResult,
  ImportSkillsInput,
  ImportSourceInput,
  RepointInput,
  SetGitHubTokenInput,
  SkillKeyInput,
  UpdateDiff,
  UpdatesView,
} from "./importer";
import {
  ActivityExport,
  ActivityFilter,
  ActivityList,
  ActivityQuery,
  AddProjectMcpServers,
  AddProjectSkills,
  AdoptInput,
  AdoptPlan,
  AgentCard,
  AgentId,
  AppliedCollection,
  ApplyAdoptInput,
  ApplyCollectionInput,
  ApplyMcpAdoptInput,
  ApplyRenameNamespaceInput,
  type ClientKind,
  Collection,
  CollectionPlan,
  CollectionPlanInput,
  CopyDiff,
  type CoreEvent,
  CoreInfo,
  type CoreNotification,
  CreateCollectionInput,
  FulfilLockInput,
  Inbox,
  LibraryList,
  LibraryMcpList,
  ManagedMcpServer,
  McpAdoptInput,
  McpAdoptPlan,
  McpChangeInput,
  McpChangePlan,
  McpOffScope,
  McpServerName,
  McpTarget,
  OffScope,
  Overview,
  OwnedFileName,
  OwnedFileProblem,
  PreferencesPatch,
  ProjectDetail,
  ProjectMcpServer,
  ProjectMcpServers,
  ProjectPath,
  ProjectSkill,
  ProjectSkillChange,
  ProjectSkillRef,
  ProjectSkills,
  ProjectSummary,
  PullProjectMcpServer,
  RemoveProjectMcpServer,
  RenameCollectionInput,
  RenameNamespaceInput,
  RenameNamespacePlan,
  RepoMcpServers,
  RepoSkills,
  RequestRecord,
  SavedSkillFile,
  SaveSkillFileInput,
  ScanResult,
  ScanStatus,
  SchedulerStatus,
  SetCollectionItemsInput,
  SetProjectMcpServerMode,
  SetProjectMcpServerOn,
  SetSecretInput,
  SettingsFile,
  SkillDeletePlan,
  SkillDetail,
  SkillFileContent,
  SkillFilePath,
  SkillFiles,
  SkillProjectUse,
  SuggestedProjectSkills,
  SuggestedProjects,
  UpdateMcpDefinitionInput,
  UpdateProjectMcpServer,
} from "./schemas";
import { SkillsShGetInput, SkillsShSearch, SkillsShSearchInput } from "./skills-sh";

/** Per-connection context, built once when a connection authenticates. */
export interface CoreContext {
  client: ClientKind;
  /** The Agent behind an `mcp` or `cli` client, when it said (ADR-0006). */
  agent?: string | undefined;
  /** Set only by the core itself when it applies a Request you approved: that call needs no consent. */
  approved?: string | undefined;
}

/** One mutation on its way in, for the consent check. */
export interface GuardedCall extends CoreContext {
  /** The procedure path, e.g. `project.addSkills`. */
  path: string;
  /** The input as sent, before validation. */
  input: unknown;
}

/**
 * Everything the router needs from the core. The core implements this; the
 * router only validates, routes and maps errors, so it can live here and give
 * every client the `AppRouter` type without depending on the core.
 */
export interface CoreServices {
  /**
   * The one policy check every mutation passes (ADR-0006), with the calling
   * client: runs `next` (the mutation), turns it into a Request, or refuses it.
   */
  consent<T>(call: GuardedCall, next: () => Promise<T>): Promise<T>;
  /** Requests from Agents and the CLI (#44). */
  requests: {
    /** Every Request still kept (pending, and decided ones until they're 24 hours old), newest first. */
    list(): RequestRecord[];
    get(id: string): RequestRecord;
    /** Re-validates the Request against the current state and applies it. */
    approve(id: string, client: ClientKind): Promise<RequestRecord>;
    deny(id: string, client: ClientKind): Promise<RequestRecord>;
  };
  info(): CoreInfo;
  library: {
    list(): Promise<LibraryList>;
  };
  settings: {
    get(): SettingsFile;
    updatePreferences(patch: PreferencesPatch, client: ClientKind): Promise<SettingsFile>;
    /** Records that the First run is done (finished or skipped); keeps the first time. */
    completeFirstRun(client: ClientKind): Promise<SettingsFile>;
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
    list(): Promise<Inbox>;
    /** Leaves a finding alone from now on (recorded in `settings.json`). */
    ignore(id: string, client: ClientKind): Promise<void>;
    /** Only the ignored findings, grouped as in the Inbox. */
    ignored(): Promise<Inbox>;
    /** Puts an ignored finding back in the Inbox. */
    unignore(id: string, client: ClientKind): Promise<void>;
  };
  agents: {
    list(): AgentCard[];
    /** Every Agent-managed MCP Server the latest Scan found, off ones included (#40). */
    managedMcp(): ManagedMcpServer[];
  };
  overview: {
    /** The overview screens' stat cards and alerts (#45), from the latest Scan, the Inbox and drift. */
    get(): Promise<Overview>;
  };
  drift: {
    /** Re-applies owned intent for a drift finding (#42). */
    restore(id: string, client: ClientKind): Promise<void>;
    /** Updates `projects.json` to match the disk for a drift finding (#42). */
    accept(id: string, client: ClientKind): Promise<void>;
  };
  managedSkills: {
    /**
     * "Turn off everywhere": turns an Agent-managed Skill off through its Agent's
     * own global settings, with a targeted, format-preserving edit.
     */
    turnOff(input: { id: string; scope: OffScope }, client: ClientKind): Promise<void>;
  };
  managedMcp: {
    /**
     * "Turn off everywhere" for an Agent-managed MCP Server, through its Agent's
     * own documented global setting, with a targeted, format-preserving edit.
     */
    turnOff(input: { id: string; scope: McpOffScope }, client: ClientKind): Promise<void>;
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
    /** Stores or rotates a Secret in the keychain, then rewrites the Personal deliveries that use it. */
    setSecret(input: SetSecretInput, client: ClientKind): Promise<void>;
    /** Replaces a Library MCP Server's definition, then rewrites its Personal deliveries. */
    updateDefinition(input: UpdateMcpDefinitionInput, client: ClientKind): Promise<void>;
    /** Deletes a Secret from the keychain (#39). Refused while an On Personal delivery uses it. */
    deleteSecret(input: { name: string }, client: ClientKind): Promise<void>;
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
  importer: {
    /** Finds the Skills in a GitHub Source at its tracked ref's head, for the picker. Writes nothing to the Library. */
    preview(input: ImportSourceInput): Promise<ImportPreview>;
    /** Imports the picked Skills at the previewed commit; ones already Imported from the same path get an update check instead. */
    import(input: ImportSkillsInput, client: ClientKind): Promise<ImportResult>;
    /** Which GitHub credentials Import uses. */
    auth(): Promise<GitHubAuthStatus>;
    /** Stores (or with null removes) the GitHub PAT in the keychain. */
    setToken(input: SetGitHubTokenInput, client: ClientKind): Promise<GitHubAuthStatus>;
    /** Check for updates (#33): one head call per Source, then folder tree SHAs. Never applies anything. */
    checkUpdates(input: CheckUpdatesInput, client: ClientKind): Promise<UpdatesView>;
    /** The Updates list from the last checks, plus Orphaned Skills. */
    updates(): Promise<UpdatesView>;
    /** The diff between the Library's folder and the waiting upstream version. */
    updateDiff(key: string): Promise<UpdateDiff>;
    /** Applies updates per Skill; a Modified Skill needs a choice. */
    applyUpdates(input: ApplyUpdatesInput, client: ClientKind): Promise<AppliedUpdates>;
    /** Detach: the Skill becomes `local/<name>`, its Source is dropped and its Links re-created. */
    detach(key: string, client: ClientKind): Promise<DetachResult>;
    /** Points a Skill at another repo, path or tag and takes that version (yours goes to `trash/`). */
    repoint(input: RepointInput, client: ClientKind): Promise<void>;
  };
  skillsSh: {
    /** Searches skills.sh (debounce in the UI; the core keeps within 30 requests a minute and caches). */
    search(input: SkillsShSearchInput): Promise<SkillsShSearch>;
    /** Get: resolves the listing to its repo and Skill folder and Imports it through GitHub Import. */
    get(input: SkillsShGetInput, client: ClientKind): Promise<ImportResult>;
  };
  /** OS notifications for the app to show, from now on, until `signal` aborts. */
  notifications(signal: AbortSignal): AsyncIterable<CoreNotification>;
  project: {
    /** Suggested Projects from the last Scan, minus confirmed and dismissed ones. */
    suggested(): SuggestedProjects;
    /** The Skills already in each waiting Suggested Project, read now (First run). Nothing before a Scan. */
    suggestedSkills(): Promise<SuggestedProjectSkills[]>;
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
    /** Its Project MCP Servers, with each Agent's delivery (#38). */
    mcpServers(path: string): Promise<ProjectMcpServer[]>;
    /** Where Personal would write for each of its Agents, and whether it's offered there. */
    mcpTargets(path: string): Promise<McpTarget[]>;
    /** Adds Library MCP Servers to Projects (Personal by default) and delivers them On. Re-adding one turns it On. */
    addMcpServers(input: AddProjectMcpServers, client: ClientKind): Promise<ProjectMcpServers[]>;
    /** On writes its entries back; Off removes them but keeps it (mode included) in `projects.json`. */
    setMcpServerOn(input: SetProjectMcpServerOn, client: ClientKind): Promise<ProjectMcpServers>;
    /** Removes a Project MCP Server: its entries go and the Project forgets it. */
    removeMcpServer(input: RemoveProjectMcpServer, client: ClientKind): Promise<ProjectMcpServers>;
    /** Switches a Project MCP Server between Personal and Shared (#39). */
    setMcpServerMode(input: SetProjectMcpServerMode, client: ClientKind): Promise<ProjectMcpServers>;
    /** The dry run of a Project MCP Server change: the edits, env vars and whether it's a team change. Writes nothing. */
    mcpPlan(input: McpChangeInput): Promise<McpChangePlan>;
    /** Updates an outdated (or, confirmed, modified in repo) Shared delivery to the Library version. */
    updateMcpServer(input: UpdateProjectMcpServer, client: ClientKind): Promise<ProjectMcpServers>;
    /** Pulls a Shared entry modified in repo into the Library definition; other Projects' Shared deliveries go outdated. */
    pullMcpServer(input: PullProjectMcpServer, client: ClientKind): Promise<ProjectMcpServers>;
    /** Trusts the Project in Codex (`projects."<path>".trust_level`), after you confirm. Never done automatically. */
    trustInCodex(path: string, client: ClientKind): Promise<ProjectMcpServers>;
    /** MCP entries in the Project Dark Matter didn't write: Vendored (committed) and untracked (Adoptable). */
    repoMcpServers(path: string): Promise<RepoMcpServers>;
    /** Turns the Project's Grant on or off (#44). */
    setGrant(input: { path: string; grant: boolean }, client: ClientKind): Promise<ProjectDetail>;
  };
  collections: {
    list(): Promise<Collection[]>;
    create(input: CreateCollectionInput, client: ClientKind): Promise<Collection>;
    rename(input: RenameCollectionInput, client: ClientKind): Promise<Collection>;
    /** Replaces its items. Projects that used it don't change: a Collection is a template. */
    setItems(input: SetCollectionItemsInput, client: ClientKind): Promise<Collection>;
    delete(name: string, client: ClientKind): Promise<void>;
    /** The dry run of adding it to Projects: per item and Project, what would happen. Writes nothing. */
    plan(input: CollectionPlanInput): Promise<CollectionPlan>;
    /** Adds the chosen items as ordinary Project Skills; items blocked in a Project are skipped and reported. */
    apply(input: ApplyCollectionInput, client: ClientKind): Promise<AppliedCollection>;
  };
  /** Core events from now on, until `signal` aborts. */
  events(signal: AbortSignal): AsyncIterable<CoreEvent>;
}

const base = initTRPC.context<CoreContext>().create({
  errorFormatter({ shape, error }) {
    const tag = isTaggedError(error.cause) ? error.cause._tag : null;
    // A pending Request isn't a failure: the caller gets its id and plan.
    const request = error.cause instanceof RequestPending ? { request: error.cause.request } : {};
    return { ...shape, data: { ...shape.data, tag, ...request } };
  },
});

export const createAppRouter = (services: CoreServices) => {
  // Every procedure is built on this one, so no mutation can skip the consent check (ADR-0006).
  const t = {
    router: base.router,
    procedure: base.procedure.use(async ({ ctx, path, type, getRawInput, next }) =>
      type === "mutation" ? services.consent({ ...ctx, path, input: await getRawInput() }, () => next()) : next(),
    ),
  };
  return t.router({
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
      completeFirstRun: t.procedure
        .output(SettingsFile)
        .mutation(({ ctx }) => services.settings.completeFirstRun(ctx.client)),
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
      ignored: t.procedure.output(Inbox).query(() => services.inbox.ignored()),
      unignore: t.procedure
        .input(z.object({ id: z.string().min(1) }))
        .mutation(({ input, ctx }) => services.inbox.unignore(input.id, ctx.client)),
    }),
    overview: t.router({
      get: t.procedure.output(Overview).query(() => services.overview.get()),
    }),
    drift: t.router({
      restore: t.procedure
        .input(z.object({ id: z.string().min(1) }))
        .mutation(({ input, ctx }) => services.drift.restore(input.id, ctx.client)),
      accept: t.procedure
        .input(z.object({ id: z.string().min(1) }))
        .mutation(({ input, ctx }) => services.drift.accept(input.id, ctx.client)),
    }),
    agents: t.router({
      list: t.procedure.output(AgentCard.array()).query(() => services.agents.list()),
      managedMcp: t.procedure.output(ManagedMcpServer.array()).query(() => services.agents.managedMcp()),
    }),
    managedSkills: t.router({
      turnOff: t.procedure
        .input(z.object({ id: z.string().min(1), scope: OffScope }))
        .mutation(({ input, ctx }) => services.managedSkills.turnOff(input, ctx.client)),
    }),
    managedMcp: t.router({
      turnOff: t.procedure
        .input(z.object({ id: z.string().min(1), scope: McpOffScope }))
        .mutation(({ input, ctx }) => services.managedMcp.turnOff(input, ctx.client)),
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
      setSecret: t.procedure
        .input(SetSecretInput)
        .mutation(({ input, ctx }) => services.mcp.setSecret(input, ctx.client)),
      updateDefinition: t.procedure
        .input(UpdateMcpDefinitionInput)
        .mutation(({ input, ctx }) => services.mcp.updateDefinition(input, ctx.client)),
      deleteSecret: t.procedure
        .input(z.object({ name: z.string().min(1) }))
        .mutation(({ input, ctx }) => services.mcp.deleteSecret(input, ctx.client)),
    }),
    scheduler: t.router({
      status: t.procedure.output(SchedulerStatus).query(() => services.scheduler.status()),
    }),
    project: t.router({
      suggested: t.procedure.output(SuggestedProjects).query(() => services.project.suggested()),
      suggestedSkills: t.procedure
        .output(SuggestedProjectSkills.array())
        .query(() => services.project.suggestedSkills()),
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
      mcpServers: t.procedure
        .input(ProjectPath)
        .output(ProjectMcpServer.array())
        .query(({ input }) => services.project.mcpServers(input.path)),
      mcpTargets: t.procedure
        .input(ProjectPath)
        .output(McpTarget.array())
        .query(({ input }) => services.project.mcpTargets(input.path)),
      addMcpServers: t.procedure
        .input(AddProjectMcpServers)
        .output(ProjectMcpServers.array())
        .mutation(({ input, ctx }) => services.project.addMcpServers(input, ctx.client)),
      setMcpServerOn: t.procedure
        .input(SetProjectMcpServerOn)
        .output(ProjectMcpServers)
        .mutation(({ input, ctx }) => services.project.setMcpServerOn(input, ctx.client)),
      removeMcpServer: t.procedure
        .input(RemoveProjectMcpServer)
        .output(ProjectMcpServers)
        .mutation(({ input, ctx }) => services.project.removeMcpServer(input, ctx.client)),
      setMcpServerMode: t.procedure
        .input(SetProjectMcpServerMode)
        .output(ProjectMcpServers)
        .mutation(({ input, ctx }) => services.project.setMcpServerMode(input, ctx.client)),
      mcpPlan: t.procedure
        .input(McpChangeInput)
        .output(McpChangePlan)
        .query(({ input }) => services.project.mcpPlan(input)),
      updateMcpServer: t.procedure
        .input(UpdateProjectMcpServer)
        .output(ProjectMcpServers)
        .mutation(({ input, ctx }) => services.project.updateMcpServer(input, ctx.client)),
      pullMcpServer: t.procedure
        .input(PullProjectMcpServer)
        .output(ProjectMcpServers)
        .mutation(({ input, ctx }) => services.project.pullMcpServer(input, ctx.client)),
      trustInCodex: t.procedure
        .input(ProjectPath)
        .output(ProjectMcpServers)
        .mutation(({ input, ctx }) => services.project.trustInCodex(input.path, ctx.client)),
      repoMcpServers: t.procedure
        .input(ProjectPath)
        .output(RepoMcpServers)
        .query(({ input }) => services.project.repoMcpServers(input.path)),
      setGrant: t.procedure
        .input(ProjectPath.extend({ grant: z.boolean() }))
        .output(ProjectDetail)
        .mutation(({ input, ctx }) => services.project.setGrant(input, ctx.client)),
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
    collections: t.router({
      list: t.procedure.output(Collection.array()).query(() => services.collections.list()),
      create: t.procedure
        .input(CreateCollectionInput)
        .output(Collection)
        .mutation(({ input, ctx }) => services.collections.create(input, ctx.client)),
      rename: t.procedure
        .input(RenameCollectionInput)
        .output(Collection)
        .mutation(({ input, ctx }) => services.collections.rename(input, ctx.client)),
      setItems: t.procedure
        .input(SetCollectionItemsInput)
        .output(Collection)
        .mutation(({ input, ctx }) => services.collections.setItems(input, ctx.client)),
      delete: t.procedure
        .input(z.object({ name: z.string().min(1) }))
        .mutation(({ input, ctx }) => services.collections.delete(input.name, ctx.client)),
      plan: t.procedure
        .input(CollectionPlanInput)
        .output(CollectionPlan)
        .query(({ input }) => services.collections.plan(input)),
      // `apply` is reserved by tRPC.
      execute: t.procedure
        .input(ApplyCollectionInput)
        .output(AppliedCollection)
        .mutation(({ input, ctx }) => services.collections.apply(input, ctx.client)),
    }),
    importer: t.router({
      preview: t.procedure
        .input(ImportSourceInput)
        .output(ImportPreview)
        .query(({ input }) => services.importer.preview(input)),
      import: t.procedure
        .input(ImportSkillsInput)
        .output(ImportResult)
        .mutation(({ input, ctx }) => services.importer.import(input, ctx.client)),
      auth: t.procedure.output(GitHubAuthStatus).query(() => services.importer.auth()),
      setToken: t.procedure
        .input(SetGitHubTokenInput)
        .output(GitHubAuthStatus)
        .mutation(({ input, ctx }) => services.importer.setToken(input, ctx.client)),
      checkUpdates: t.procedure
        .input(CheckUpdatesInput)
        .output(UpdatesView)
        .mutation(({ input, ctx }) => services.importer.checkUpdates(input, ctx.client)),
      updates: t.procedure.output(UpdatesView).query(() => services.importer.updates()),
      updateDiff: t.procedure
        .input(SkillKeyInput)
        .output(UpdateDiff)
        .query(({ input }) => services.importer.updateDiff(input.key)),
      applyUpdates: t.procedure
        .input(ApplyUpdatesInput)
        .output(AppliedUpdates)
        .mutation(({ input, ctx }) => services.importer.applyUpdates(input, ctx.client)),
      detach: t.procedure
        .input(SkillKeyInput)
        .output(DetachResult)
        .mutation(({ input, ctx }) => services.importer.detach(input.key, ctx.client)),
      repoint: t.procedure
        .input(RepointInput)
        .mutation(({ input, ctx }) => services.importer.repoint(input, ctx.client)),
    }),
    skillsSh: t.router({
      search: t.procedure
        .input(SkillsShSearchInput)
        .output(SkillsShSearch)
        .query(({ input }) => services.skillsSh.search(input)),
      get: t.procedure
        .input(SkillsShGetInput)
        .output(ImportResult)
        .mutation(({ input, ctx }) => services.skillsSh.get(input, ctx.client)),
    }),
    events: t.procedure.subscription(async function* ({ signal }) {
      yield* services.events(signal ?? new AbortController().signal);
    }),
    notifications: t.procedure.subscription(async function* ({ signal }) {
      yield* services.notifications(signal ?? new AbortController().signal);
    }),
    requests: t.router({
      list: t.procedure.output(RequestRecord.array()).query(() => services.requests.list()),
      get: t.procedure
        .input(z.object({ id: z.string().min(1) }))
        .output(RequestRecord)
        .query(({ input }) => services.requests.get(input.id)),
      approve: t.procedure
        .input(z.object({ id: z.string().min(1) }))
        .output(RequestRecord)
        .mutation(({ input, ctx }) => services.requests.approve(input.id, ctx.client)),
      deny: t.procedure
        .input(z.object({ id: z.string().min(1) }))
        .output(RequestRecord)
        .mutation(({ input, ctx }) => services.requests.deny(input.id, ctx.client)),
    }),
  });
};

export type AppRouter = ReturnType<typeof createAppRouter>;
