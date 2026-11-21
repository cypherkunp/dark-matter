import { lstat, mkdir, readdir, readFile, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type ActivityClient,
  LibraryLockEntry,
  PathTaken,
  type SkillDeleteImpact,
  type SkillDeletePlan,
  SkillNotFound,
  type TrashedSkill,
  TrashedSkillNotFound,
} from "@dark-matter/contracts";
import { z } from "zod";
import type { ActivityLog, Wrote } from "./activity";
import { writeFileAtomic } from "./atomic";
import type { Clock } from "./clock";
import { type Library, splitKey } from "./library";
import type { DailyJob } from "./scheduler";
import { WriteQueue } from "./write-queue";

const DAY = 24 * 60 * 60 * 1000;

/** `trash/<id>/trashed.json`: what was deleted and when, so it can be put back or purged. */
const Trashed = z.object({
  key: z.string(),
  deletedAt: z.iso.datetime(),
  entry: z.unknown(),
  /**
   * "skill": a deleted Library Skill (restorable); "version": your version set
   * aside by Take upstream; "drift": what a drift Restore moved out of a Project.
   * Absent means "skill".
   */
  kind: z.enum(["skill", "version", "drift"]).optional(),
});

/** Records what's in a `trash/` folder so the daily purge removes it after the retention (review #14). */
export const writeTrashed = (into: string, record: z.infer<typeof Trashed>) =>
  writeFileAtomic(join(into, "trashed.json"), `${JSON.stringify(record, null, 2)}\n`);

/**
 * The Projects a Library Skill's deletion affects. Project delivery (#27/#28)
 * supplies it: Links to the Skill break, Copies stay behind.
 */
export type SkillUsage = (key: string) => Promise<SkillDeleteImpact[]>;

export interface TrashOptions {
  /** The core's one write queue (review #8). */
  writes?: WriteQueue;
  library: Library;
  activity: ActivityLog;
  clock: Clock;
  retentionDays: () => number;
  usage: SkillUsage;
  /** Removes the Skill's Links and Project records everywhere first (Copies stay). */
  release: (key: string, wrote: Wrote) => Promise<void>;
  onChange: () => void;
}

/**
 * Deleting Library Skills (#34). A deleted Skill moves to
 * `trash/<time>-<key>/<name>/` next to a `trashed.json` holding its Library
 * Lock entry, and is purged by the daily run after `retentionDays`. A Local
 * Source moves only its Library symlink; the folder it's authored in is never touched.
 */
export class Trash {
  private readonly root: string;

  constructor(private readonly options: TrashOptions) {
    this.root = join(options.library.libraryHome, "trash");
  }

  private entry(key: string): LibraryLockEntry {
    const entry = this.options.library.lock.value.skills[key];
    if (!entry) throw new SkillNotFound(key);
    return entry;
  }

  async plan(key: string): Promise<SkillDeletePlan> {
    this.entry(key);
    return { key, retentionDays: this.options.retentionDays(), projects: await this.options.usage(key) };
  }

  delete(key: string, client: ActivityClient): Promise<void> {
    const { library, activity } = this.options;
    const writes = this.options.writes ?? new WriteQueue();
    return writes.run(() => this.#delete(key, client, library, activity));
  }

  #delete(key: string, client: ActivityClient, library: Library, activity: ActivityLog): Promise<void> {
    return activity.track({ client, action: "skill.delete", subjects: [{ kind: "skill", id: key }] }, async (wrote) => {
      this.entry(key);
      await this.options.release(key, wrote);
      const folder = library.folder(key);
      const { into, trashed } = await this.moveIn(key);
      try {
        wrote(
          await library.lock.update((current) => {
            const { [key]: _deleted, ...skills } = current.skills;
            return { ...current, skills };
          }),
        );
      } catch (error) {
        await rename(trashed, folder);
        await rm(into, { recursive: true, force: true });
        throw error;
      }
      wrote(trashed);
      await this.pruneEmpty(dirname(folder));
      this.options.onChange();
    });
  }

  /** Moves a Skill's folder into `trash/` beside a `trashed.json`; the Library Lock is left alone. */
  private async moveIn(key: string, kind: "skill" | "version" = "skill"): Promise<{ into: string; trashed: string }> {
    const entry = this.entry(key);
    const deletedAt = this.options.clock.now().toISOString();
    const id = `${deletedAt.replaceAll(":", "-")}-${key.replaceAll("/", "__")}`;
    const into = join(this.root, id);
    const trashed = join(into, splitKey(key).name);
    await mkdir(into, { recursive: true });
    await writeTrashed(into, { key, deletedAt, entry, ...(kind !== "skill" && { kind }) });
    await rename(this.options.library.folder(key), trashed);
    return { into, trashed };
  }

  /**
   * Take upstream (#33): your version of a Skill goes to `trash/` (purged like
   * any deleted Skill) while it stays in the Library Lock for the new one.
   * Returns where it went.
   */
  async keepVersion(key: string): Promise<string> {
    return (await this.moveIn(key, "version")).trashed;
  }

  /** Removes Namespace folders the deletion left empty, up to `skills/`. */
  private async pruneEmpty(dir: string) {
    const skills = join(this.options.library.libraryHome, "skills");
    for (let at = dir; at.startsWith(`${skills}/`); at = dirname(at)) {
      if (
        !(await rmdir(at).then(
          () => true,
          () => false,
        ))
      )
        return;
    }
  }

  /** What's in `trash/`, read from each folder's `trashed.json`. */
  async #entries(): Promise<{ id: string; dir: string; trashed: z.infer<typeof Trashed> }[]> {
    const found: { id: string; dir: string; trashed: z.infer<typeof Trashed> }[] = [];
    for (const id of await readdir(this.root).catch(() => [])) {
      const dir = join(this.root, id);
      const trashed = await readFile(join(dir, "trashed.json"), "utf8")
        .then((text) => Trashed.parse(JSON.parse(text)))
        .catch(() => null);
      if (trashed) found.push({ id, dir, trashed });
    }
    return found;
  }

  /** Deleted Library Skills that can be restored, newest first (story 44). */
  async list(): Promise<TrashedSkill[]> {
    const days = this.options.retentionDays();
    return (await this.#entries())
      .filter(({ trashed }) => (trashed.kind ?? "skill") === "skill")
      .map(({ id, trashed }) => ({
        id,
        key: trashed.key,
        name: splitKey(trashed.key).name,
        deletedAt: trashed.deletedAt,
        purgeAt: new Date(Date.parse(trashed.deletedAt) + days * DAY).toISOString(),
      }))
      .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt) || a.id.localeCompare(b.id));
  }

  /**
   * Restore (story 44): the Skill's folder goes back to its Library folder and
   * its Library Lock entry comes back. Refused (`PathTaken`) while another
   * Skill holds the key; Projects are re-added by hand, as Delete removed them.
   */
  restore(id: string, client: ActivityClient): Promise<void> {
    const writes = this.options.writes ?? new WriteQueue();
    return writes.run(async () => {
      const found = (await this.#entries()).find(
        (candidate) => candidate.id === id && (candidate.trashed.kind ?? "skill") === "skill",
      );
      if (!found) throw new TrashedSkillNotFound(id);
      const { key, entry } = found.trashed;
      const { library, activity } = this.options;
      await activity.track(
        { client, action: "trash.restore", subjects: [{ kind: "skill", id: key }] },
        async (wrote) => {
          const folder = library.folder(key);
          if (
            library.lock.value.skills[key] ||
            (await lstat(folder).then(
              () => true,
              () => false,
            ))
          )
            throw new PathTaken(folder);
          await mkdir(dirname(folder), { recursive: true });
          await rename(join(found.dir, splitKey(key).name), folder);
          try {
            wrote(
              await library.lock.update((current) => ({
                ...current,
                skills: { ...current.skills, [key]: LibraryLockEntry.parse(entry) },
              })),
            );
          } catch (error) {
            await rename(folder, join(found.dir, splitKey(key).name));
            throw error;
          }
          wrote(folder);
          await rm(found.dir, { recursive: true, force: true });
          this.options.onChange();
        },
      );
    });
  }

  /** Purges trash older than the retention; returns the purged Skills' keys. */
  async purge(client: ActivityClient): Promise<void> {
    const cutoff = this.options.clock.now().getTime() - this.options.retentionDays() * DAY;
    const expired = (await this.#entries())
      .filter(({ trashed }) => Date.parse(trashed.deletedAt) <= cutoff)
      .map(({ dir, trashed }) => ({ dir, key: trashed.key }));
    if (expired.length === 0) return;
    await this.options.activity.track(
      {
        client,
        action: "trash.purge",
        // Drift leftovers aren't Skills: their key names the Project.
        subjects: expired.map(({ key }) =>
          key.startsWith("drift:")
            ? { kind: "project" as const, id: key.slice("drift:".length) }
            : { kind: "skill" as const, id: key },
        ),
      },
      async () => {
        for (const { dir } of expired) await rm(dir, { recursive: true, force: true });
      },
    );
  }

  /** The daily job that empties expired trash. */
  job(): DailyJob {
    return { name: "trash.purge", run: ({ client }) => this.purge(client) };
  }
}
