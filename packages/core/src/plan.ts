import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readlink, rename, rm, rmdir, stat, symlink, unlink } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { KeychainUnavailable, PathTaken, type PlanStep, PlanTargetChanged } from "@dark-matter/contracts";
import type { Wrote } from "./activity";
import { writeFileAtomic } from "./atomic";
import { fromHomeRelative } from "./home-path";
import { log } from "./log";
import { fingerprintSkillFolder } from "./skill-hash";
import { toSortedJson } from "./sorted-json";

/**
 * The plan-and-apply shape every file-writing mutation shares: a planner
 * returns `PlanStep`s (the dry run), `planId` fingerprints them, and
 * `applySteps` carries them out in order. Apply re-plans and compares ids, so a
 * stale plan never runs.
 */
export const planId = (value: unknown): string =>
  createHash("sha256").update(toSortedJson(value)).digest("hex").slice(0, 16);

export interface ApplyContext {
  home: string;
  libraryHome: string;
  wrote: Wrote;
  /** Carries out `editFile` steps (owned files, the global lock); returns the paths written. */
  editFile(step: Extract<PlanStep, { kind: "editFile" }>): Promise<string[]>;
  /** Carries out `storeSecret` and `deleteSecret` steps (the keychain); plans without them leave it out. */
  secret?(step: Extract<PlanStep, { kind: "storeSecret" | "deleteSecret" }>): Promise<void>;
  /** Told which files a rollback put back, so owned files held in memory can reload them. */
  restored?(paths: string[]): Promise<void>;
  /** The last part of the transaction, after every step: if it throws, the steps are reversed too. */
  finish?(): Promise<void>;
}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/** Where a copy is assembled before its final rename: `staging/` for the Library, else beside the target. */
const stagingFor = (to: string, libraryHome: string) =>
  to.startsWith(libraryHome + sep)
    ? join(libraryHome, "staging", randomUUID())
    : join(dirname(to), `.dark-matter-staging-${randomUUID()}`);

/** Copies a folder (symlinks kept as they are) next to `to`, then renames it into place. */
const copyIntoPlace = async (from: string, to: string, libraryHome: string) => {
  const staging = stagingFor(to, libraryHome);
  await mkdir(dirname(staging), { recursive: true });
  try {
    await cp(from, staging, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    await rename(staging, to);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
};

/** Moves a folder: a rename, or across devices a staged copy then removing the original. */
const moveFolder = async (from: string, to: string, libraryHome: string) => {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyIntoPlace(from, to, libraryHome);
    await rm(from, { recursive: true });
  }
};

/**
 * The paths steps will create, minus those an earlier step frees first. All
 * must be vacant before the first step runs, so a taken one stops the plan
 * before anything moves.
 */
const targetsOf = (steps: readonly PlanStep[]): string[] => {
  const freed = new Set<string>();
  const targets: string[] = [];
  for (const step of steps) {
    if (step.kind === "move") freed.add(step.from);
    if (step.kind === "removeLink" || step.kind === "removeCopy" || step.kind === "removeFolder") freed.add(step.path);
    const target =
      step.kind === "move" || step.kind === "copy" ? step.to : step.kind === "createLink" ? step.path : null;
    if (target && !freed.has(target)) targets.push(target);
  }
  return targets;
};

/** Moves a folder out of the way into staging, so a removal can be reversed until the plan finishes. */
const stash = async (path: string, libraryHome: string) => {
  const into = stagingFor(path, libraryHome);
  await mkdir(dirname(into), { recursive: true });
  await moveFolder(path, into, libraryHome);
  return into;
};

/**
 * Applies steps in order, as one transaction (review #7). Nothing is ever
 * overwritten: a taken target throws `PathTaken` before any step runs. Each
 * completed step records how to reverse it, and if a later step fails, the
 * completed ones are reversed in reverse order before the error is rethrown.
 * Removed folders are stashed rather than deleted until every step succeeded;
 * the file an `editFile` step names is put back byte for byte (`restored` is told).
 * A Secret stored in the keychain stays there (it's harmless and named).
 */
export const applySteps = async (steps: readonly PlanStep[], context: ApplyContext): Promise<void> => {
  const abs = (path: string) => fromHomeRelative(context.home, path);
  for (const target of targetsOf(steps)) {
    if (await exists(abs(target))) throw new PathTaken(abs(target));
  }
  /** How to reverse each completed step, newest last. */
  const undo: (() => Promise<void>)[] = [];
  const vacant = async (path: string) => {
    if (await exists(path)) throw new PathTaken(path);
    const made = await mkdir(dirname(path), { recursive: true });
    // Folders made for it go on rollback too, innermost first, while they're empty.
    if (made)
      undo.push(async () => {
        for (let dir = dirname(path); dir.length >= made.length; dir = dirname(dir)) await rmdir(dir);
      });
  };
  /** Removed folders waiting to be deleted once every step succeeded. */
  const stashed: string[] = [];
  try {
    for (const step of steps) {
      switch (step.kind) {
        case "move": {
          const from = abs(step.from);
          const to = abs(step.to);
          await vacant(to);
          await moveFolder(from, to, context.libraryHome);
          undo.push(() => moveFolder(to, from, context.libraryHome));
          context.wrote(to);
          break;
        }
        case "copy": {
          const to = abs(step.to);
          await vacant(to);
          await copyIntoPlace(abs(step.from), to, context.libraryHome);
          undo.push(() => rm(to, { recursive: true, force: true }));
          context.wrote(to);
          break;
        }
        case "createLink": {
          const path = abs(step.path);
          await vacant(path);
          await symlink(step.target, path, "dir");
          undo.push(() => unlink(path));
          context.wrote(path);
          break;
        }
        case "removeLink": {
          const path = abs(step.path);
          if (!(await lstat(path)).isSymbolicLink()) throw new PlanTargetChanged(path, "is no longer a symlink");
          const target = await readlink(path);
          await unlink(path);
          undo.push(() => symlink(target, path, "dir"));
          context.wrote(path);
          break;
        }
        case "removeCopy": {
          // Re-checked right before removing: only a byte-for-byte duplicate of a kept folder goes.
          const path = abs(step.path);
          if ((await fingerprintSkillFolder(path)) !== (await fingerprintSkillFolder(abs(step.sameAs)))) {
            throw new PlanTargetChanged(path, `no longer matches ${step.sameAs}`);
          }
          const into = await stash(path, context.libraryHome);
          stashed.push(into);
          undo.push(() => moveFolder(into, path, context.libraryHome));
          context.wrote(path);
          break;
        }
        case "removeFolder": {
          const path = abs(step.path);
          const info = await lstat(path);
          if (info.isSymbolicLink() || !info.isDirectory()) throw new PlanTargetChanged(path, "is no longer a folder");
          const into = await stash(path, context.libraryHome);
          stashed.push(into);
          undo.push(() => moveFolder(into, path, context.libraryHome));
          context.wrote(path);
          break;
        }
        case "editFile": {
          // Its file as it was, with its mode, so a rollback puts it back byte for byte.
          const path = abs(step.path);
          const text = await readFile(path, "utf8").catch(() => null);
          const mode = text === null ? undefined : (await stat(path)).mode & 0o777;
          const written = await context.editFile(step);
          undo.push(async () => {
            if (text === null) await rm(path, { force: true });
            else await writeFileAtomic(path, text, mode);
            await context.restored?.([path]);
          });
          for (const path of written) context.wrote(path);
          break;
        }
        case "storeSecret":
        case "deleteSecret":
          if (!context.secret) throw new KeychainUnavailable(`nothing can carry out ${step.kind} ${step.name}`);
          await context.secret(step);
          break;
      }
    }
    await context.finish?.();
  } catch (error) {
    for (const reverse of undo.reverse()) {
      try {
        await reverse();
      } catch (undoError) {
        // Keep reversing the rest; the original failure is what the caller sees.
        log(`couldn't reverse a step after a failed plan: ${String(undoError)}`);
      }
    }
    throw error;
  }
  for (const into of stashed) await rm(into, { recursive: true, force: true });
};
