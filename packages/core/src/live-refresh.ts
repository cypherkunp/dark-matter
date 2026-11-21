import { dirname, join, sep } from "node:path";
import type { Domain } from "@dark-matter/contracts";
import { type AgentPathEnv, agentAdapters } from "./agents";
import type { Clock } from "./clock";
import type { EventBus } from "./events";
import { forgetSkillHashes } from "./skill-hash";
import { FolderWatcher, type WatchRoot } from "./watcher";

/** An owned file (ADR-0005) the watcher re-reads when it changes. */
interface Reloadable {
  path: string;
  reload(): Promise<boolean>;
}

export interface LiveRefreshOptions {
  env: AgentPathEnv;
  libraryHome: string;
  ownedFiles: readonly Reloadable[];
  /** A hand edit changed an owned file's value or problem. */
  onOwnedFileChanged(): void;
  /** Re-reads the MCP definitions under `mcp/` (validate or hold). */
  reloadMcp(): Promise<void>;
  /** Confirmed Projects, by absolute path. */
  projectPaths(): readonly string[];
  /** Whether a Scan has ever run: Agent folders aren't read before the first one (First run asks). */
  scanned(): boolean;
  /** An unlogged re-Scan, for Agent and Project folder changes (Inbox, untracked Skills). */
  rescan(): void;
  bus: EventBus;
  clock: Clock;
  onError(error: unknown): void;
}

/** Under the Library home, only these change on their own; the rest is the core's own churn. */
const LIBRARY_IGNORE = ["state", "activity", "trash", "backups", "staging", "core.json", "core.lock"];
const PROJECT_IGNORE = [".git", "**/node_modules"];
const RESYNC_MS = 60_000;

const inside = (path: string, root: string) => path === root || path.startsWith(root + sep);

/**
 * Live refresh (#42): one `FolderWatcher` over the Library home, every
 * Project folder and (after the first Scan) the Agents' global skill folders.
 * Each debounced burst re-reads owned files, forgets cached Skill hashes,
 * pushes `invalidate` events for what changed and re-Scans for Agent or
 * Project changes. The watched set follows `projects.json` and the Scan.
 */
export const startLiveRefresh = async (options: LiveRefreshOptions) => {
  const { libraryHome } = options;
  const mcpDir = join(libraryHome, "mcp");
  const skillsDir = join(libraryHome, "skills");
  const agentFolders = () =>
    options.scanned()
      ? [...new Set(agentAdapters.flatMap((adapter) => adapter.skills.globalFolders(options.env).map((f) => f.path)))]
      : [];
  const roots = (): WatchRoot[] => [
    { path: libraryHome, ignore: LIBRARY_IGNORE },
    ...options.projectPaths().map((path) => ({ path, ignore: PROJECT_IGNORE })),
    ...agentFolders().map((path) => ({ path })),
  ];
  const sync = () => watcher.sync(roots()).catch(options.onError);

  const onChanges = async (paths: string[]) => {
    forgetSkillHashes(paths);
    const domains = new Set<Domain>();
    let rescan = false;
    if (paths.some((path) => dirname(path) === libraryHome)) {
      const reloaded = await Promise.all(options.ownedFiles.map((file) => file.reload().catch(options.onError)));
      if (reloaded.some(Boolean)) options.onOwnedFileChanged();
    }
    if (paths.some((path) => inside(path, mcpDir))) {
      await options.reloadMcp().catch(options.onError);
      domains.add("mcp");
    }
    if (paths.some((path) => inside(path, skillsDir)))
      for (const domain of ["library", "skill", "project"] as const) domains.add(domain);
    const projects = options.projectPaths();
    if (paths.some((path) => projects.some((project) => inside(path, project)))) {
      domains.add("project").add("inbox");
      rescan = true;
    }
    const folders = agentFolders();
    if (paths.some((path) => folders.some((folder) => inside(path, folder)))) rescan = true;
    if (domains.size > 0) options.bus.publish({ type: "invalidate", domains: [...domains] });
    if (rescan && options.scanned()) options.rescan();
    await sync();
  };

  const watcher = new FolderWatcher({
    onChanges: (paths) => void onChanges(paths).catch(options.onError),
    onError: options.onError,
  });
  await sync();
  const stopTimer = options.clock.every(RESYNC_MS, () => void sync());
  return {
    /** Re-reads which folders to watch, e.g. after a Scan or a change to `projects.json`. */
    sync,
    close: async () => {
      stopTimer();
      await watcher.close();
    },
  };
};
