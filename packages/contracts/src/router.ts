import { initTRPC } from "@trpc/server";
import { z } from "zod";
import { isTaggedError } from "./errors";
import {
  ActivityList,
  ActivityQuery,
  type ClientKind,
  type CoreEvent,
  CoreInfo,
  LibraryList,
  OwnedFileName,
  OwnedFileProblem,
  PreferencesPatch,
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
    events: t.procedure.subscription(async function* ({ signal }) {
      yield* services.events(signal ?? new AbortController().signal);
    }),
  });

export type AppRouter = ReturnType<typeof createAppRouter>;
