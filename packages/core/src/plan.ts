import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, rename, rm, symlink, unlink } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { PathTaken, type PlanStep } from "@dark-matter/contracts";
import type { Wrote } from "./activity";
import { fromHomeRelative } from "./home-path";
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
    if (step.kind === "removeLink" || step.kind === "removeCopy") freed.add(step.path);
    const target =
      step.kind === "move" || step.kind === "copy" ? step.to : step.kind === "createLink" ? step.path : null;
    if (target && !freed.has(target)) targets.push(target);
  }
  return targets;
};

/** Applies steps in order. Nothing is ever overwritten: a taken target throws `PathTaken` before any step runs. */
export const applySteps = async (steps: readonly PlanStep[], context: ApplyContext): Promise<void> => {
  const abs = (path: string) => fromHomeRelative(context.home, path);
  for (const target of targetsOf(steps)) {
    if (await exists(abs(target))) throw new PathTaken(abs(target));
  }
  const vacant = async (path: string) => {
    if (await exists(path)) throw new PathTaken(path);
    await mkdir(dirname(path), { recursive: true });
  };
  for (const step of steps) {
    switch (step.kind) {
      case "move": {
        const to = abs(step.to);
        await vacant(to);
        await moveFolder(abs(step.from), to, context.libraryHome);
        context.wrote(to);
        break;
      }
      case "copy": {
        const to = abs(step.to);
        await vacant(to);
        await copyIntoPlace(abs(step.from), to, context.libraryHome);
        context.wrote(to);
        break;
      }
      case "createLink": {
        const path = abs(step.path);
        await vacant(path);
        await symlink(step.target, path, "dir");
        context.wrote(path);
        break;
      }
      case "removeLink": {
        const path = abs(step.path);
        if (!(await lstat(path)).isSymbolicLink()) throw new Error(`${path} is no longer a symlink`);
        await unlink(path);
        context.wrote(path);
        break;
      }
      case "removeCopy": {
        // Re-checked right before removing: only a byte-for-byte duplicate of a kept folder goes.
        const path = abs(step.path);
        if ((await fingerprintSkillFolder(path)) !== (await fingerprintSkillFolder(abs(step.sameAs)))) {
          throw new Error(`${path} no longer matches ${step.sameAs}; nothing was removed`);
        }
        await rm(path, { recursive: true });
        context.wrote(path);
        break;
      }
      case "editFile":
        for (const path of await context.editFile(step)) context.wrote(path);
        break;
      case "storeSecret":
      case "deleteSecret":
        if (!context.secret) throw new Error(`no keychain to carry out ${step.kind} ${step.name}`);
        await context.secret(step);
        break;
    }
  }
};
