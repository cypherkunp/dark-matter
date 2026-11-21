import { readdir, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type ApplyRenameNamespaceInput,
  type ClientKind,
  InvalidOwnedFile,
  type KeyRename,
  NameConflict,
  NamespaceNotFound,
  PlanStale,
  type PlanStep,
  type RenameNamespaceInput,
  type RenameNamespacePlan,
} from "@dark-matter/contracts";
import type { ActivityLog } from "./activity";
import { homeRelative } from "./home-path";
import { type Library, splitKey } from "./library";
import { applySteps, planId } from "./plan";

type EditFileStep = Extract<PlanStep, { kind: "editFile" }>;

/**
 * What else must follow a Library Skill to its new key. Links (#27) register
 * one: their `steps` re-create every Link to a renamed Skill (removeLink then
 * createLink at the new folder), and `editFile` re-keys `projects.json`.
 */
export interface KeyRenameHook {
  /** Steps run after the Library folders move. */
  steps(renames: KeyRename[]): Promise<PlanStep[]>;
  /** Carries out one of this hook's own `editFile` steps; null when the step isn't its own. */
  editFile(step: EditFileStep, renames: KeyRename[]): Promise<string[] | null>;
}

export interface NamespaceRenameOptions {
  home: string;
  library: Library;
  activity: ActivityLog;
  /** Filled in by later tickets; empty until Links exist. */
  hooks: readonly KeyRenameHook[];
  onChange: () => void;
}

/** Rename Namespace (#24): moves a Namespace's Skill folders and re-keys them in the Library Lock. */
export class NamespaceRename {
  readonly #options: NamespaceRenameOptions;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: NamespaceRenameOptions) {
    this.#options = options;
  }

  async plan({ from, to }: RenameNamespaceInput): Promise<RenameNamespacePlan> {
    const { library, home, hooks } = this.#options;
    const rel = (path: string) => homeRelative(home, path);
    const keys = Object.keys(library.lock.value.skills);
    const renames = keys
      .filter((key) => splitKey(key).namespace === from)
      .sort()
      .map((key) => ({ from: key, to: `${to}/${splitKey(key).name}` }));
    if (renames.length === 0) throw new NamespaceNotFound(from);
    const taken = renames.filter((rename) => keys.includes(rename.to)).map((rename) => rename.to);
    if (taken.length > 0) throw new NameConflict(taken);

    const steps: PlanStep[] = [
      ...renames.map(
        (rename): PlanStep => ({
          kind: "move",
          from: rel(library.folder(rename.from)),
          to: rel(library.folder(rename.to)),
        }),
      ),
      {
        kind: "editFile",
        path: rel(library.lock.path),
        change: `rename ${renames.map((rename) => `${rename.from} → ${rename.to}`).join(", ")}`,
      },
    ];
    for (const hook of hooks) steps.push(...(await hook.steps(renames)));
    const body = { from, to, renames, steps, warnings: [] };
    return { planId: planId(body), ...body };
  }

  rename(input: ApplyRenameNamespaceInput, client: ClientKind): Promise<RenameNamespacePlan> {
    return this.#serial(async () => {
      const { library, home, activity, hooks } = this.#options;
      const plan = await this.plan(input);
      const subjects = plan.renames.flatMap((rename) => [
        { kind: "skill" as const, id: rename.from },
        { kind: "skill" as const, id: rename.to },
      ]);
      return activity.track({ client, action: "namespace.rename", subjects }, async (wrote) => {
        if (plan.planId !== input.planId) throw new PlanStale();
        const problem = library.lock.problem;
        if (problem) throw new InvalidOwnedFile(problem.path, problem.message);
        const lockPath = homeRelative(home, library.lock.path);
        await applySteps(plan.steps, {
          home,
          libraryHome: library.libraryHome,
          wrote,
          editFile: async (step) => {
            if (step.path === lockPath) {
              const path = await library.lock.update((current) => {
                const skills = { ...current.skills };
                for (const rename of plan.renames) {
                  const entry = skills[rename.from];
                  delete skills[rename.from];
                  if (entry) skills[rename.to] = entry;
                }
                return { ...current, skills };
              });
              return path ? [path] : [];
            }
            for (const hook of hooks) {
              const written = await hook.editFile(step, plan.renames);
              if (written) return written;
            }
            throw new Error(`Nothing knows how to edit ${step.path}`);
          },
        });
        await removeEmptyFolders(library.folder(plan.renames[0]?.from ?? ""), join(library.libraryHome, "skills"));
        this.#options.onChange();
        return plan;
      });
    });
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => {});
    return run;
  }
}

/** Removes the old Namespace's now-empty folders (`owner/repo`, then `owner`), stopping at `root`. */
export const removeEmptyFolders = async (skillFolder: string, root: string) => {
  for (let folder = dirname(skillFolder); folder.startsWith(`${root}/`); folder = dirname(folder)) {
    const entries = await readdir(folder).catch(() => null);
    if (entries === null || entries.length > 0) return;
    await rmdir(folder).catch(() => {});
  }
};
