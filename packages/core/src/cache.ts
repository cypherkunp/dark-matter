import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { log } from "./log";

/**
 * Bump when the schema changes. The cache is never migrated (ADR-0005): a
 * different `user_version` drops the db and the core rebuilds it from files.
 */
const CACHE_VERSION = 3;

const SCHEMA = `
  CREATE TABLE activity_files (
    name TEXT PRIMARY KEY,
    size INTEGER NOT NULL
  );
  CREATE TABLE activity (
    id TEXT NOT NULL,
    file TEXT NOT NULL,
    time TEXT NOT NULL,
    entry TEXT NOT NULL
  );
  CREATE INDEX activity_by_time ON activity (time DESC);
  CREATE INDEX activity_by_file ON activity (file);
  CREATE TABLE scan (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    result TEXT NOT NULL
  );
  CREATE TABLE source_checks (
    source TEXT NOT NULL,
    ref TEXT NOT NULL,
    status TEXT NOT NULL,
    folders TEXT,
    PRIMARY KEY (source, ref)
  );
  CREATE TABLE skill_updates (
    key TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    ref TEXT NOT NULL,
    "update" TEXT NOT NULL
  );
  CREATE TABLE github_status (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    status TEXT NOT NULL
  );
`;

const open = (path: string): DatabaseSync => {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (user_version === CACHE_VERSION) return db;
    if (user_version !== 0) throw new Error(`cache version ${user_version}, want ${CACHE_VERSION}`);
    db.exec(`BEGIN; ${SCHEMA} PRAGMA user_version = ${CACHE_VERSION}; COMMIT;`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
};

/**
 * Opens `state/dark-matter.db`, the disposable cache (ADR-0005). A missing,
 * corrupt or outdated db is dropped and created empty; callers then rebuild
 * what they cache from the owned files.
 */
export const openCache = async (libraryHome: string): Promise<DatabaseSync> => {
  const stateDir = join(libraryHome, "state");
  const path = join(stateDir, "dark-matter.db");
  await mkdir(stateDir, { recursive: true });
  try {
    return open(path);
  } catch (error) {
    log(`dropping the cache: ${error instanceof Error ? error.message : String(error)}`);
    await Promise.all(["", "-wal", "-shm"].map((suffix) => rm(`${path}${suffix}`, { force: true })));
    return open(path);
  }
};
