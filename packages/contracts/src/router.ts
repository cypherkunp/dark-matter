import { initTRPC } from "@trpc/server";
import { z } from "zod";
import { isTaggedError } from "./errors";
import {
  ActivityList,
  ActivityQuery,
  AdoptInput,
  AdoptPlan,
  AgentCard,
  ApplyAdoptInput,
  type ClientKind,
  type CoreEvent,
  CoreInfo,
  Inbox,
  LibraryList,
  OwnedFileName,
  OwnedFileProblem,
  PreferencesPatch,
  ScanResult,
  ScanStatus,
  SettingsFile,
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
  adopt: {
    /** The dry run: what Adopting these findings would do. Writes nothing. */
    plan(input: AdoptInput): Promise<AdoptPlan>;
    /** Re-plans, checks the plan id still matches, then applies it. */
    apply(input: ApplyAdoptInput, client: ClientKind): Promise<AdoptPlan>;
    /** Undo Adopt: moves the Skill back to where it was Adopted from and puts back what Adopt removed. */
    undo(key: string, client: ClientKind): Promise<void>;
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
    adopt: t.router({
      plan: t.procedure
        .input(AdoptInput)
        .output(AdoptPlan)
        .mutation(({ input }) => services.adopt.plan(input)),
      // `apply` is reserved by tRPC, so the procedure that applies a plan is `execute`.
      execute: t.procedure
        .input(ApplyAdoptInput)
        .output(AdoptPlan)
        .mutation(({ input, ctx }) => services.adopt.apply(input, ctx.client)),
      undo: t.procedure
        .input(z.object({ key: z.string().min(1) }))
        .mutation(({ input, ctx }) => services.adopt.undo(input.key, ctx.client)),
    }),
    events: t.procedure.subscription(async function* ({ signal }) {
      yield* services.events(signal ?? new AbortController().signal);
    }),
  });

export type AppRouter = ReturnType<typeof createAppRouter>;
