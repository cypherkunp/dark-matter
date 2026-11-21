import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  type ActivityClient,
  ActivityEntry,
  type ActivityExport,
  type ActivityFilter,
  type ActivityList,
  type ActivityQuery,
  type ActivityRetention,
  type ActivitySubject,
  isTaggedError,
} from "@dark-matter/contracts";
import { currentCaller } from "./caller";
import { homeRelative } from "./home-path";
import type { DailyJob } from "./scheduler";

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

const hasSubject = (kind: string) =>
  `EXISTS (SELECT 1 FROM json_each(entry, '$.subjects') WHERE json_extract(value, '$.kind') = '${kind}' AND json_extract(value, '$.id') = ?)`;

/** The SQL for an Activity filter, as a WHERE clause over the `activity` index. */
const whereClause = (filter: ActivityFilter): { where: string; params: SQLInputValue[] } => {
  const conditions: string[] = [];
  const params: SQLInputValue[] = [];
  if (filter.skill !== undefined) {
    conditions.push(hasSubject("skill"));
    params.push(filter.skill);
  }
  const anyOf = (field: string, values: readonly string[] | undefined) => {
    // An empty list is no filter, like a filter menu with nothing picked.
    if (!values?.length) return;
    conditions.push(`json_extract(entry, '$.${field}') IN (${values.map(() => "?").join(", ")})`);
    params.push(...values);
  };
  anyOf("action", filter.actions);
  anyOf("client", filter.clients);
  if (filter.failuresOnly) conditions.push("json_extract(entry, '$.result') = 'error'");
  if (filter.from !== undefined) {
    conditions.push("time >= ?");
    params.push(new Date(filter.from).toISOString());
  }
  if (filter.to !== undefined) {
    conditions.push("time < ?");
    params.push(new Date(filter.to).toISOString());
  }
  const search = filter.search?.trim();
  if (search) {
    // Text values only, not field names or bookkeeping (the entry id, its time, its result, subject kinds).
    conditions.push(`EXISTS (SELECT 1 FROM json_tree(entry) WHERE type = 'text'
      AND fullkey NOT IN ('$.id', '$.time', '$.result') AND key IS NOT 'kind'
      AND instr(lower(value), lower(?)) > 0)`);
    params.push(search);
  }
  if (filter.project !== undefined) {
    conditions.push(hasSubject("project"));
    params.push(filter.project);
  }
  return { where: conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`, params };
};

/** What a change is, before it runs. */
export interface ActivityOperation {
  client: ActivityClient;
  /** `<domain>.<operation>`, matching the RPC procedure where there is one. */
  action: string;
  subjects: ActivitySubject[];
}

/** Collects the files an operation wrote; `null` (nothing written) is ignored. */
export type Wrote = (path: string | null) => void;

export interface ActivityLogOptions {
  libraryHome: string;
  home: string;
  cache: DatabaseSync;
  /** Called after each entry is recorded, and after retention deletes day files. */
  onRecorded: () => void;
  now?: () => Date;
}

/**
 * The Activity Log (ADR-0005): append-only `activity/YYYY-MM-DD.jsonl` files
 * (UTC day of the entry's time) are the truth, indexed in the cache for queries.
 */
export class ActivityLog {
  readonly #dir: string;
  readonly #options: ActivityLogOptions;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(options: ActivityLogOptions) {
    this.#options = options;
    this.#dir = join(options.libraryHome, "activity");
  }

  /** Opens the log and brings the cache index up to date with the day files. */
  static async open(options: ActivityLogOptions): Promise<ActivityLog> {
    const activity = new ActivityLog(options);
    await activity.#reindex();
    return activity;
  }

  /**
   * Runs one change and records it: `ok` with the files it wrote, or `error`
   * with its tag and message (the error is rethrown).
   */
  async track<T>(operation: ActivityOperation, run: (wrote: Wrote) => Promise<T>): Promise<T> {
    const files: string[] = [];
    const wrote: Wrote = (path) => {
      if (path !== null) files.push(path);
    };
    try {
      const value = await run(wrote);
      await this.record({ ...operation, result: "ok", filesWritten: files });
      return value;
    } catch (error) {
      await this.record({
        ...operation,
        result: "error",
        error: {
          tag: isTaggedError(error) ? error._tag : null,
          message: error instanceof Error ? error.message : String(error),
        },
        filesWritten: files,
      });
      throw error;
    }
  }

  /** Appends one entry to today's file and indexes it. */
  record(input: Omit<ActivityEntry, "id" | "time">): Promise<ActivityEntry> {
    // The Agent and Request a change was made for (ADR-0006), read before queueing.
    const caller = currentCaller();
    const run = this.#queue.then(async () => {
      const entry = ActivityEntry.parse({
        ...caller,
        ...input,
        id: randomUUID(),
        time: this.#now().toISOString(),
        filesWritten: input.filesWritten.map((path) => homeRelative(this.#options.home, path)),
      });
      const name = `${entry.time.slice(0, 10)}.jsonl`;
      const path = join(this.#dir, name);
      await mkdir(this.#dir, { recursive: true });
      await appendFile(path, `${JSON.stringify(entry)}\n`);
      const { size } = await stat(path);
      this.#transaction(() => {
        this.#insert(name, entry);
        this.#setSize(name, size);
      });
      this.#options.onRecorded();
      return entry;
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  /** Entries matching the filters, newest first. */
  list({ limit, ...filter }: ActivityQuery): ActivityList {
    return { entries: this.#select(filter, limit) };
  }

  /** Every entry matching the filter, newest first, with when and how it was filtered. */
  export(filter: ActivityFilter): ActivityExport {
    return { exportedAt: this.#now().toISOString(), filter, entries: this.#select(filter, -1) };
  }

  /** `limit` -1 is no limit. */
  #select(filter: ActivityFilter, limit: number): ActivityEntry[] {
    const { where, params } = whereClause(filter);
    const rows = this.#options.cache
      .prepare(`SELECT entry FROM activity ${where} ORDER BY time DESC, rowid DESC LIMIT ?`)
      .all(...params, limit) as { entry: string }[];
    return rows.map((row) => ActivityEntry.parse(JSON.parse(row.entry)));
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date();
  }

  /**
   * Deletes the day files older than `retention` days before today (UTC, like
   * the file names) and drops them from the index. It isn't recorded itself:
   * it follows the retention setting, and changing that setting is recorded.
   */
  prune(retention: ActivityRetention): Promise<string[]> {
    const run = this.#queue.then(async () => {
      if (retention === "forever") return [];
      const cutoff = new Date(this.#now());
      cutoff.setUTCDate(cutoff.getUTCDate() - retention);
      const oldest = `${cutoff.toISOString().slice(0, 10)}.jsonl`;
      const expired = (await this.#dayFiles()).filter((name) => name < oldest);
      for (const name of expired) {
        await rm(join(this.#dir, name), { force: true });
        this.#transaction(() => this.#forget(name));
      }
      if (expired.length > 0) this.#options.onRecorded();
      return expired;
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  async #dayFiles(): Promise<string[]> {
    return (await readdir(this.#dir).catch(() => [] as string[])).filter((name) => DAY_FILE.test(name)).sort();
  }

  /** Whether any recorded entry has this action, e.g. whether a Scan has ever run. */
  hasAction(action: string): boolean {
    return (
      this.#options.cache
        .prepare("SELECT 1 FROM activity WHERE json_extract(entry, '$.action') = ? LIMIT 1")
        .get(action) !== undefined
    );
  }

  /** The time of the newest entry matching `filter`, or null if there is none. */
  latest(filter: { action?: string; client?: ActivityClient }): Date | null {
    const row = this.#options.cache
      .prepare(
        `SELECT time FROM activity
         WHERE (?1 IS NULL OR json_extract(entry, '$.action') = ?1)
           AND (?2 IS NULL OR json_extract(entry, '$.client') = ?2)
         ORDER BY time DESC LIMIT 1`,
      )
      .get(filter.action ?? null, filter.client ?? null) as { time: string } | undefined;
    return row ? new Date(row.time) : null;
  }

  /** Re-reads each day file whose size differs from what the index has seen, and forgets deleted ones. */
  async #reindex(): Promise<void> {
    const names = await this.#dayFiles();
    const cache = this.#options.cache;
    const indexed = new Map(
      (cache.prepare("SELECT name, size FROM activity_files").all() as { name: string; size: number }[]).map((row) => [
        row.name,
        row.size,
      ]),
    );
    for (const name of indexed.keys()) {
      if (!names.includes(name)) this.#transaction(() => this.#forget(name));
    }
    for (const name of names) {
      const text = await readFile(join(this.#dir, name), "utf8");
      const size = Buffer.byteLength(text);
      if (indexed.get(name) === size) continue;
      const entries = text
        .split("\n")
        .filter((line) => line.trim() !== "")
        .flatMap((line) => {
          try {
            const parsed = ActivityEntry.safeParse(JSON.parse(line));
            return parsed.success ? [parsed.data] : [];
          } catch {
            // A damaged line (a hand edit, a crash mid-append) is skipped, not fatal.
            return [];
          }
        });
      this.#transaction(() => {
        this.#forget(name);
        for (const entry of entries) this.#insert(name, entry);
        this.#setSize(name, size);
      });
    }
  }

  #insert(file: string, entry: ActivityEntry) {
    this.#options.cache
      .prepare("INSERT INTO activity (id, file, time, entry) VALUES (?, ?, ?, ?)")
      .run(entry.id, file, entry.time, JSON.stringify(entry));
  }

  #setSize(name: string, size: number) {
    this.#options.cache
      .prepare(
        "INSERT INTO activity_files (name, size) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET size = excluded.size",
      )
      .run(name, size);
  }

  #forget(name: string) {
    this.#options.cache.prepare("DELETE FROM activity WHERE file = ?").run(name);
    this.#options.cache.prepare("DELETE FROM activity_files WHERE name = ?").run(name);
  }

  #transaction(work: () => void) {
    const cache = this.#options.cache;
    cache.exec("BEGIN");
    try {
      work();
      cache.exec("COMMIT");
    } catch (error) {
      cache.exec("ROLLBACK");
      throw error;
    }
  }
}

/** The daily run's retention cleanup: day files that have aged past the setting are deleted. */
export const retentionJob = (activity: ActivityLog, retention: () => ActivityRetention): DailyJob => ({
  name: "activity retention",
  run: async () => {
    await activity.prune(retention());
  },
});
