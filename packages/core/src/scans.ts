import type { DatabaseSync } from "node:sqlite";
import { type ActivityClient, ScanResult, type ScanStatus } from "@dark-matter/contracts";
import type { ActivityLog } from "./activity";
import { type AgentPathEnv, agentAdapters } from "./agents";
import { log } from "./log";
import { scan } from "./scanner";

export interface ScansOptions {
  env: AgentPathEnv;
  cache: DatabaseSync;
  activity: ActivityLog;
  /** Called when a Scan starts and when it finishes. */
  onChange: () => void;
}

/**
 * Runs Scans and keeps the latest result in the cache (ADR-0005). One Scan at
 * a time: asking again while one runs joins it.
 */
export class Scans {
  readonly #options: ScansOptions;
  #latest: ScanResult | null;
  #running: Promise<ScanResult> | null = null;

  constructor(options: ScansOptions) {
    this.#options = options;
    this.#latest = readCached(options.cache);
  }

  get latest(): ScanResult | null {
    return this.#latest;
  }

  status(): ScanStatus {
    return { running: this.#running !== null, lastScanAt: this.#latest?.scannedAt ?? null };
  }

  /** A Scan someone asked for, recorded in the Activity Log. */
  run(client: ActivityClient): Promise<ScanResult> {
    this.#running ??= this.#start(() =>
      this.#options.activity.track({ client, action: "scan.run", subjects: [] }, () => this.#scan()),
    );
    return this.#running;
  }

  /**
   * The catch-up Scan on start: refreshes the cache in the background once a
   * Scan has ever run, i.e. it's cached or in the Activity Log. Before the
   * first Scan nothing is read (the First run asks first).
   */
  catchUp(): void {
    if (this.#running || (this.#latest === null && !this.#options.activity.hasAction("scan.run"))) return;
    this.#running = this.#start(() => this.#scan());
    this.#running.catch((error: unknown) => log(`catch-up Scan failed: ${String(error)}`));
  }

  /** A Scan after the core changed an Agent's settings, so the cache shows it. Not logged on its own. */
  async refresh(): Promise<ScanResult> {
    await this.settle();
    this.#running ??= this.#start(() => this.#scan());
    return this.#running;
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
    const result = await scan(this.#options.env, agentAdapters);
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
