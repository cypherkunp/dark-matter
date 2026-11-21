import { initTRPC } from "@trpc/server";
import { z } from "zod";
import { isTaggedError } from "./errors";
import {
  ActivityList,
  ActivityQuery,
  AdoptInput,
  AdoptPlan,
  AgentCard,
  AgentId,
  ApplyAdoptInput,
  ApplyRenameNamespaceInput,
  type ClientKind,
  type CoreEvent,
  CoreInfo,
  type CoreNotification,
  Inbox,
  LibraryList,
  OffScope,
  OwnedFileName,
  OwnedFileProblem,
  PreferencesPatch,
  ProjectDetail,
  ProjectPath,
  ProjectSummary,
  RenameNamespaceInput,
  RenameNamespacePlan,
  ScanResult,
  ScanStatus,
  SchedulerStatus,
  SettingsFile,
  SkillDetail,
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
  skill: {
    /** A Library Skill's page: SKILL.md split into frontmatter and body, warnings and its Library Lock entry. */
    get(key: string): Promise<SkillDetail>;
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
    }),
    skill: t.router({
      get: t.procedure
        .input(z.object({ key: z.string().min(1) }))
        .output(SkillDetail)
        .query(({ input }) => services.skill.get(input.key)),
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
