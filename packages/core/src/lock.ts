import { randomBytes } from "node:crypto";
import { link, open, readFile, rename, rm, stat } from "node:fs/promises";
import { CoreLocked } from "@dark-matter/contracts";

interface LockHolder {
  pid: number;
  nonce?: string;
}

/** How long a lock file may stay empty (created, not yet written) before it counts as abandoned. */
const UNWRITTEN_GRACE_MS = 5_000;

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const readHolder = async (path: string): Promise<LockHolder | null> => {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<LockHolder>;
    return typeof parsed.pid === "number" ? (parsed as LockHolder) : null;
  } catch {
    return null;
  }
};

const isCode = (error: unknown, code: string) => (error as NodeJS.ErrnoException).code === code;

/**
 * Takes `core.lock` so this core is the Library's only writer (ADR-0003).
 * Throws `CoreLocked` while a live process holds it. A lock left by a dead
 * process is taken over. Resolves to a function that releases the lock.
 */
export const acquireCoreLock = async (path: string): Promise<() => Promise<void>> => {
  const nonce = randomBytes(12).toString("hex");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({ pid: process.pid, nonce }));
      } finally {
        await file.close();
      }
      return async () => {
        if ((await readHolder(path))?.nonce === nonce) await rm(path, { force: true });
      };
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
    }

    const holder = await readHolder(path);
    if (holder === null) {
      // Another core may be between creating and writing the lock.
      const age = await stat(path).then(
        (s) => Date.now() - s.mtimeMs,
        () => Infinity,
      );
      if (age < UNWRITTEN_GRACE_MS) throw new CoreLocked(path, 0);
    } else if (isAlive(holder.pid)) {
      throw new CoreLocked(path, holder.pid);
    }
    await takeOverStale(path, holder);
  }
  throw new CoreLocked(path, (await readHolder(path))?.pid ?? 0);
};

/**
 * Moves a stale lock aside. If a peer replaced it with a fresh lock in the
 * meantime, the fresh one is put back and this core backs off.
 */
const takeOverStale = async (path: string, stale: LockHolder | null) => {
  const aside = `${path}.stale-${randomBytes(6).toString("hex")}`;
  try {
    await rename(path, aside);
  } catch (error) {
    if (isCode(error, "ENOENT")) return;
    throw error;
  }
  const moved = await readHolder(aside);
  if (moved !== null && moved.nonce !== stale?.nonce && isAlive(moved.pid)) {
    await link(aside, path).catch(() => {});
    await rm(aside, { force: true });
    throw new CoreLocked(path, moved.pid);
  }
  await rm(aside, { force: true });
};
