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
  /** A GitHub API base URL instead of https://api.github.com, for e2e tests; the `gh` CLI's token is then never used. */
  DARK_MATTER_GITHUB_API?: string | undefined;
  /** skills.sh's base URL: e2e points the core at a fake (#31). */
  DARK_MATTER_SKILLS_SH_API?: string | undefined;
  /** Where system-wide Agent config (`/etc`, `/Library`) is read from; `/` unless a test points it at a fixture. */
  DARK_MATTER_SYSTEM_ROOT?: string | undefined;
}

/** The Library location: `DARK_MATTER_HOME`, else `$HOME/.dark-matter`. */
export const resolveLibraryHome = (env: CoreEnv): string =>
  env.DARK_MATTER_HOME || join(env.HOME || homedir(), ".dark-matter");

/** Where the core keeps its single-writer lock and publishes how to reach it. */
export const corePaths = (libraryHome: string) => ({
  lock: join(libraryHome, "core.lock"),
  coreFile: join(libraryHome, "core.json"),
});
