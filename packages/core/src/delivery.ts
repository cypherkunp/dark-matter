import { lstat, mkdir, readFile, readlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  type DeliveryMode,
  NameConflict,
  type PlanStep,
  type ProjectRecord,
  type ProjectSkill,
} from "@dark-matter/contracts";
import type { Wrote } from "./activity";
import { agentAdapters } from "./agents";
import { writeFileAtomic } from "./atomic";
import { homeRelative } from "./home-path";
import { type Library, splitKey } from "./library";
import { applySteps } from "./plan";
import { deliveryFolders } from "./projects";
import { readFrontmatter } from "./scanner";

/**
 * Project delivery (#8, #9, #27): turns a Project's record in `projects.json`
 * into files in the Project. `planDelivery` reconciles the whole Project at
 * once (every Project Skill, every Agent folder), so adding, On/Off, Remove,
 * Resolve and changing Agents are all "change the record, plan, apply".
 * Each delivery mode (Link now, Copy in #28) is a `DeliveryModeAdapter`.
 */

/** One Project Skill in one Project, as a mode adapter sees it. */
export interface DeliveryTarget {
  project: string;
  key: string;
  /** The folder name: its SKILL.md `name`. */
  name: string;
  /** The Library folder it is delivered from. */
  source: string;
}

export interface DeliveryModeAdapter {
  /** Whether the entry at `path` (absolute) is this Project Skill's delivery. */
  isDelivered(path: string, target: DeliveryTarget): Promise<boolean>;
  /**
   * Steps that make `folders` (Project-relative) hold the delivery, and remove it
   * from `unwanted` folders. Already-right entries need no step; a foreign entry
   * where a delivery should go throws `NameConflict`; a foreign entry in an
   * unwanted folder is left alone. `freed` are absolute paths earlier steps remove.
   */
  plan(
    target: DeliveryTarget,
    folders: readonly string[],
    unwanted: readonly string[],
    freed?: ReadonlySet<string>,
  ): Promise<PlanStep[]>;
  /** Whether its deliveries go in `.git/info/exclude` (personal, never committed). */
  excluded: boolean;
}

const lstatOrNull = (path: string) => lstat(path).catch(() => null);

/** A Link (#8): a directory symlink to the Library folder, never a symlinked SKILL.md (Codex rejects those). */
export const linkMode: DeliveryModeAdapter = {
  excluded: true,
  isDelivered: async (path, target) => {
    const info = await lstatOrNull(path);
    if (!info?.isSymbolicLink()) return false;
    const raw = await readlink(path);
    return resolve(dirname(path), raw) === target.source;
  },
  async plan(target, folders, unwanted, freed = new Set()) {
    const steps: PlanStep[] = [];
    for (const folder of folders) {
      const path = join(target.project, folder, target.name);
      if (await this.isDelivered(path, target)) continue;
      if (!freed.has(path) && (await lstatOrNull(path))) throw new NameConflict(target.key, join(folder, target.name));
      steps.push({ kind: "createLink", path, target: target.source });
    }
    for (const folder of unwanted) {
      const path = join(target.project, folder, target.name);
      if (await this.isDelivered(path, target)) steps.push({ kind: "removeLink", path, target: target.source });
    }
    return steps;
  },
};

export const deliveryModes: Record<DeliveryMode, DeliveryModeAdapter> = { link: linkMode };

/** Every folder any Agent can be delivered to, so changing Agents cleans up the ones dropped. */
const allDeliveryFolders = () => [...new Set(agentAdapters.map((adapter) => adapter.skills.deliveryFolder))].sort();

const SAFE_NAME = /^[^/\\.][^/\\]*$/;

/** The folder name a Library Skill is delivered under: its SKILL.md `name`, else the key's last part. */
export const deliveredName = async (library: Library, key: string): Promise<string> => {
  const { name } = await readFrontmatter(library.folder(key)).catch(() => ({ name: undefined }));
  return name && SAFE_NAME.test(name) ? name : splitKey(key).name;
};

/** The info/exclude file of a Project's git repo (worktrees share the main repo's), or null without git. */
export const gitExcludeFile = async (project: string): Promise<string | null> => {
  const dotGit = join(project, ".git");
  const info = await lstatOrNull(dotGit);
  if (!info) return null;
  if (info.isDirectory()) return join(dotGit, "info", "exclude");
  const match = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, "utf8"));
  if (!match?.[1]) return null;
  const gitDir = resolve(project, match[1].trim());
  const common = await readFile(join(gitDir, "commondir"), "utf8").then(
    (text) => text.trim(),
    () => null,
  );
  const root = common ? (isAbsolute(common) ? common : resolve(gitDir, common)) : gitDir;
  return join(root, "info", "exclude");
};

const BLOCK_START = "# Dark Matter Links (managed by Dark Matter; edits inside this block are replaced)";
const BLOCK_END = "# End of Dark Matter Links";

/** `text` with Dark Matter's block replaced by `paths` (removed when empty); everything else kept as is. */
export const withExcludeBlock = (text: string, paths: readonly string[]): string => {
  const lines = text.split("\n");
  const start = lines.indexOf(BLOCK_START);
  const end = start === -1 ? -1 : lines.indexOf(BLOCK_END, start);
  const kept = start === -1 || end === -1 ? lines : [...lines.slice(0, start), ...lines.slice(end + 1)];
  let body = kept.join("\n").replace(/\n+$/, "");
  if (paths.length > 0) {
    const block = [BLOCK_START, ...paths.map((path) => `/${path}`), BLOCK_END].join("\n");
    body = body ? `${body}\n\n${block}` : block;
  }
  return body ? `${body}\n` : "";
};

export interface DeliveryPlan {
  steps: PlanStep[];
  skills: ProjectSkill[];
  /** The info/exclude file and its new text, when it changes. */
  exclude: { path: string; text: string } | null;
}

/**
 * Plans the files that make `project` match `record`. `removed` are Library
 * keys the record just dropped, whose deliveries go too. Name Conflicts (two
 * Project Skills with one name) deliver neither one anew and leave an existing
 * delivery where it is until Resolve.
 */
export const planDelivery = async (
  library: Library,
  project: string,
  record: ProjectRecord,
  removed: readonly string[] = [],
): Promise<DeliveryPlan> => {
  const chosen = deliveryFolders(record.agents);
  const every = allDeliveryFolders();
  const others = every.filter((folder) => !chosen.includes(folder));
  const keys = Object.keys(record.skills).sort();
  const names = new Map<string, string>();
  for (const key of [...keys, ...removed]) names.set(key, await deliveredName(library, key));
  const target = (key: string): DeliveryTarget => ({
    project,
    key,
    name: names.get(key) ?? splitKey(key).name,
    source: library.folder(key),
  });

  const steps: PlanStep[] = [];
  const excluded: string[] = [];
  const skills: ProjectSkill[] = [];
  for (const key of removed) steps.push(...(await linkMode.plan(target(key), [], every)));
  const freed = new Set(steps.flatMap((step) => (step.kind === "removeLink" ? [step.path] : [])));
  for (const key of keys) {
    const wanted = record.skills[key];
    if (!wanted) continue;
    const mode = deliveryModes[wanted.mode];
    const it = target(key);
    const conflictsWith = keys.filter((other) => other !== key && names.get(other) === it.name);
    const status = conflictsWith.length > 0 ? "nameConflict" : wanted.on ? "on" : "off";
    if (status === "nameConflict") {
      // Leave what's there; only drop it from folders the Project's Agents no longer use.
      steps.push(...(await mode.plan(it, [], others)));
      for (const folder of chosen)
        if (mode.excluded && (await mode.isDelivered(join(project, folder, it.name), it)))
          excluded.push(join(folder, it.name));
    } else if (status === "on") {
      steps.push(...(await mode.plan(it, chosen, others, freed)));
      if (mode.excluded) excluded.push(...chosen.map((folder) => join(folder, it.name)));
    } else steps.push(...(await mode.plan(it, [], every)));
    const { namespace } = splitKey(key);
    skills.push({
      key,
      namespace,
      name: it.name,
      mode: wanted.mode,
      on: wanted.on,
      status,
      conflictsWith,
      paths: chosen.map((folder) => join(folder, it.name)),
    });
  }

  let exclude: DeliveryPlan["exclude"] = null;
  const excludePath = await gitExcludeFile(project);
  if (excludePath) {
    const current = await readFile(excludePath, "utf8").catch(() => "");
    const text = withExcludeBlock(current, [...new Set(excluded)].sort());
    if (text !== current) {
      exclude = { path: excludePath, text };
      steps.push({ kind: "editFile", path: excludePath, change: `exclude ${excluded.length} Links from git` });
    }
  }
  return { steps, skills, exclude };
};

/** Carries out a delivery plan. Taken targets are checked before anything is written. */
export const applyDelivery = async (
  plan: DeliveryPlan,
  context: { home: string; libraryHome: string; wrote: Wrote },
) => {
  const relative = plan.steps.map((step): PlanStep => {
    if (step.kind === "createLink" || step.kind === "removeLink")
      return { ...step, path: homeRelative(context.home, step.path) };
    return step;
  });
  await applySteps(relative, {
    ...context,
    editFile: async (step) => {
      if (!plan.exclude || step.path !== plan.exclude.path) return [];
      await mkdir(dirname(plan.exclude.path), { recursive: true });
      await writeFileAtomic(plan.exclude.path, plan.exclude.text);
      return [plan.exclude.path];
    },
  });
};
