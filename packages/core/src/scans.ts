import type { DatabaseSync } from "node:sqlite";
import {
  type ActivityClient,
  type Preferences,
  type ProjectMcpEntry,
  ScanResult,
  type ScanStatus,
} from "@dark-matter/contracts";
import type { ActivityLog } from "./activity";
import { defaultPreferences, withAdoptability } from "./adopt-permissions";
import { type AgentPathEnv, agentAdapters } from "./agents";
import { log } from "./log";
import { scan } from "./scanner";

export interface ScansOptions {
  env: AgentPathEnv;
  cache: DatabaseSync;
  activity: ActivityLog;
  /** Confirmed Projects by absolute path, read at the start of each Scan. */
  projectPaths?: () => readonly string[];
  /** A Project's MCP entries Dark Matter didn't deliver (#39 carry-over), recorded with the Scan. */
  projectMcp?: (path: string) => Promise<ProjectMcpEntry[]>;
  /** Folders never suggested as Projects (the Library). */
  exclude?: readonly string[];
  /** Called when a Scan starts and when it finishes. */
  onChange: () => void;
  /** The current settings, which decide each finding's `adoptable` (ADR-0007); the defaults when left out. */
  preferences?: () => Pick<Preferences, "adoptPermissions" | "agentConfigGuard">;
}

/**
 * Runs Scans and keeps the latest result in the cache (ADR-0005). One Scan at
 * a time: asking again while one runs joins it.
 */
export class Scans {
  readonly #options: ScansOptions;
  #latest: ScanResult | null;
  #running: Promise<ScanResult> | null = null;
  /** The Scan someone asked for, from the moment they asked. */
  #asked: Promise<ScanResult> | null = null;

  constructor(options: ScansOptions) {
    this.#options = options;
    this.#latest = readCached(options.cache);
  }

  /** The latest Scan, its findings' `adoptable` worked out from the current settings. */
  get latest(): ScanResult | null {
    return this.#latest && this.#judged(this.#latest);
  }

  #judged(scan: ScanResult): ScanResult {
    return withAdoptability(scan, this.#options.preferences?.() ?? defaultPreferences());
  }

  status(): ScanStatus {
    return { running: this.#running !== null || this.#asked !== null, lastScanAt: this.#latest?.scannedAt ?? null };
  }

  /**
   * A Scan someone asked for, recorded in the Activity Log. Asking again while
   * one runs joins it; an unlogged Scan (catch-up, or a re-Scan after a change
   * on disk) may have started before what you're looking for, so it's waited
   * out and a fresh Scan follows.
   */
  run(client: ActivityClient): Promise<ScanResult> {
    this.#asked ??= (async () => {
      try {
        await this.settle();
        this.#running = this.#start(() =>
          this.#options.activity.track({ client, action: "scan.run", subjects: [] }, () => this.#scan()),
        );
        return this.#judged(await this.#running);
      } finally {
        this.#asked = null;
      }
    })();
    return this.#asked;
  }

  /**
   * The catch-up Scan on start: refreshes the cache in the background once a
   * Scan has ever run, i.e. it's cached or in the Activity Log. Before the
   * first Scan nothing is read (the First run asks first).
   */
  catchUp(): void {
    if (this.#running || this.#asked || (this.#latest === null && !this.#options.activity.hasAction("scan.run")))
      return;
    this.#running = this.#start(() => this.#scan());
    this.#running.catch((error: unknown) => log(`catch-up Scan failed: ${String(error)}`));
  }

  /**
   * A Scan after a change the core made itself (an Agent's settings, an Adopt),
   * so the cache and the Inbox catch up. Not logged on its own.
   */
  async refresh(): Promise<ScanResult> {
    if (this.#asked) return this.#asked;
    await this.settle();
    this.#running ??= this.#start(() => this.#scan());
    return this.#judged(await this.#running);
  }

  /** Waits for a running Scan, so the cache isn't closed under it. */
  async settle(): Promise<void> {
    await this.#running?.catch(() => {});
  }

  #start(work: () => Promise<ScanResult>): Promise<ScanResult> {
    const run = work().finally(() => {
      this.#running = null;
      this.#options.onChange();
    });
    this.#options.onChange();
    return run;
  }

  async #scan(): Promise<ScanResult> {
    const result = await scan(this.#options.env, agentAdapters, new Date(), {
      projects: this.#options.projectPaths?.() ?? [],
      exclude: this.#options.exclude ?? [],
    });
    const projectMcp = this.#options.projectMcp;
    if (projectMcp)
      for (const project of result.projects)
        if (project.exists) project.mcpServers = await projectMcp(project.path).catch(() => []);
    this.#options.cache
      .prepare("INSERT INTO scan (id, result) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET result = excluded.result")
      .run(JSON.stringify(result));
    this.#latest = result;
    return result;
  }
}

const readCached = (cache: DatabaseSync): ScanResult | null => {
  const row = cache.prepare("SELECT result FROM scan WHERE id = 1").get() as { result: string } | undefined;
  if (!row) return null;
  const parsed = ScanResult.safeParse(JSON.parse(row.result));
  return parsed.success ? parsed.data : null;
};
