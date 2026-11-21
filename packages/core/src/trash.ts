import { mkdir, readdir, readFile, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type ActivityClient,
  type LibraryLockEntry,
  type SkillDeleteImpact,
  type SkillDeletePlan,
  SkillNotFound,
} from "@dark-matter/contracts";
import { z } from "zod";
import type { ActivityLog } from "./activity";
import { writeFileAtomic } from "./atomic";
import type { Clock } from "./clock";
import { type Library, splitKey } from "./library";
import type { DailyJob } from "./scheduler";

const DAY = 24 * 60 * 60 * 1000;

/** `trash/<id>/trashed.json`: what was deleted and when, so it can be put back or purged. */
const Trashed = z.object({ key: z.string(), deletedAt: z.iso.datetime(), entry: z.unknown() });

/**
 * The Projects a Library Skill's deletion affects. Project delivery (#27/#28)
 * supplies it: Links to the Skill break, Copies stay behind.
 */
export type SkillUsage = (key: string) => Promise<SkillDeleteImpact[]>;

export interface TrashOptions {
  library: Library;
  activity: ActivityLog;
  clock: Clock;
  retentionDays: () => number;
  usage: SkillUsage;
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
    const { library, activity, clock } = this.options;
    return activity.track({ client, action: "skill.delete", subjects: [{ kind: "skill", id: key }] }, async (wrote) => {
      const entry = this.entry(key);
      const deletedAt = clock.now().toISOString();
      const id = `${deletedAt.replaceAll(":", "-")}-${key.replaceAll("/", "__")}`;
      const into = join(this.root, id);
      const folder = library.folder(key);
      const trashed = join(into, splitKey(key).name);
      await mkdir(into, { recursive: true });
      await writeFileAtomic(join(into, "trashed.json"), `${JSON.stringify({ key, deletedAt, entry }, null, 2)}\n`);
      await rename(folder, trashed);
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

  /** Removes Namespace folders the deletion left empty, up to `skills/`. */
  private async pruneEmpty(dir: string) {
    const skills = join(this.options.library.libraryHome, "skills");
    for (let at = dir; at.startsWith(`${skills}/`); at = dirname(at)) {
      if (!(await rmdir(at).then(() => true, () => false))) return;
    }
  }

  /** Purges trash older than the retention; returns the purged Skills' keys. */
  async purge(client: ActivityClient): Promise<void> {
    const cutoff = this.options.clock.now().getTime() - this.options.retentionDays() * DAY;
    const expired: { dir: string; key: string }[] = [];
    for (const name of await readdir(this.root).catch(() => [])) {
      const dir = join(this.root, name);
      const trashed = await readFile(join(dir, "trashed.json"), "utf8")
        .then((text) => Trashed.parse(JSON.parse(text)))
        .catch(() => null);
      if (trashed && Date.parse(trashed.deletedAt) <= cutoff) expired.push({ dir, key: trashed.key });
    }
    if (expired.length === 0) return;
    await this.options.activity.track(
      { client, action: "trash.purge", subjects: expired.map(({ key }) => ({ kind: "skill", id: key })) },
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
