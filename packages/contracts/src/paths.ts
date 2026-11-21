import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The environment variables that locate the Library. Passed in, never read
 * globally, so tests can boot cores side by side.
 */
export interface CoreEnv {
  HOME?: string | undefined;
  /** Overrides the Library location, for development and tests. */
  DARK_MATTER_HOME?: string | undefined;
  /** `memory` keeps Secrets in memory instead of the OS keychain, for development and e2e tests. */
  DARK_MATTER_SECRETS?: string | undefined;
}

/** The Library location: `DARK_MATTER_HOME`, else `$HOME/.dark-matter`. */
export const resolveLibraryHome = (env: CoreEnv): string =>
  env.DARK_MATTER_HOME || join(env.HOME || homedir(), ".dark-matter");

/** Where the core keeps its single-writer lock and publishes how to reach it. */
export const corePaths = (libraryHome: string) => ({
  lock: join(libraryHome, "core.lock"),
  coreFile: join(libraryHome, "core.json"),
});
