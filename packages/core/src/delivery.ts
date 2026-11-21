import { lstat, mkdir, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  type CopyState,
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
import {
  COPY_FOLDER,
  copyLockEntry,
  lockEntry,
  type ProjectLock,
  projectLockPath,
  projectLockText,
  readProjectLock,
} from "./project-lock";
import { deliveryFolders } from "./projects";
import { readFrontmatter } from "./scanner";
import { cachedSkillFolderHash } from "./skill-hash";

/**
 * Project delivery (#8, #9, #27): turns a Project's record in `projects.json`
 * into files in the Project. `planDelivery` reconciles the whole Project at
 * once (every Project Skill, every Agent folder), so adding, On/Off, Remove,
 * Resolve and changing Agents are all "change the record, plan, apply".
 * Each delivery mode (Link, Copy) is a `DeliveryModeAdapter`.
 */

/** One Project Skill in one Project, as a mode adapter sees it. */
export interface DeliveryTarget {
  project: string;
  key: string;
  /** The folder name: its SKILL.md `name`. */
  name: string;
  /** The Library folder it is delivered from (its real path, for a Copy). */
  source: string;
  /** A Copy only: the real folder at `.agents/skills/<name>` is this Project Skill's own, not a Vendored one. */
  claimed?: boolean;
  /** A Copy only: replace the folder with the Library's (Update, Take Library version). */
  refresh?: boolean;
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
      if (!freed.has(path) && (await lstatOrNull(path)))
        throw new NameConflict([target.key], join(folder, target.name));
      steps.push({ kind: "createLink", path, target: target.source });
    }
    for (const folder of unwanted) {
      const path = join(target.project, folder, target.name);
      if (await this.isDelivered(path, target)) steps.push({ kind: "removeLink", path, target: target.source });
    }
    return steps;
  },
};

/**
 * A Copy (#28): real files at `.agents/skills/<name>`, committed; every other
 * chosen folder (`.claude/skills`) gets a relative symlink to it, as the
 * `skills` CLI does. Its `skills-lock.json` entry is planned by `planDelivery`.
 * A real folder there counts as this Copy only when `claimed`, so a Vendored
 * Skill is never replaced or removed.
 */
export const copyMode: DeliveryModeAdapter = {
  excluded: false,
  isDelivered: async (path, target) => {
    const info = await lstatOrNull(path);
    const real = join(target.project, COPY_FOLDER, target.name);
    if (path === real) return Boolean(target.claimed && info?.isDirectory());
    return Boolean(info?.isSymbolicLink()) && (await readlink(path)) === relative(dirname(path), real);
  },
  async plan(target, folders, unwanted, freed = new Set()) {
    const steps: PlanStep[] = [];
    const real = join(target.project, COPY_FOLDER, target.name);
    const taken = async (path: string) => !freed.has(path) && Boolean(await lstatOrNull(path));
    if (folders.length > 0) {
      if (await this.isDelivered(real, target)) {
        if (target.refresh)
          steps.push({ kind: "removeFolder", path: real }, { kind: "copy", from: target.source, to: real });
      } else {
        if (await taken(real)) throw new NameConflict([target.key], join(COPY_FOLDER, target.name));
        steps.push({ kind: "copy", from: target.source, to: real });
      }
      for (const folder of folders.filter((folder) => folder !== COPY_FOLDER)) {
        const path = join(target.project, folder, target.name);
        if (await this.isDelivered(path, target)) continue;
        if (await taken(path)) throw new NameConflict([target.key], join(folder, target.name));
        steps.push({ kind: "createLink", path, target: relative(dirname(path), real) });
      }
    }
    for (const folder of unwanted.filter((folder) => folder !== COPY_FOLDER)) {
      const path = join(target.project, folder, target.name);
      if (await this.isDelivered(path, target))
        steps.push({ kind: "removeLink", path, target: relative(dirname(path), real) });
    }
    if (folders.length === 0 && (await this.isDelivered(real, target)))
      steps.push({ kind: "removeFolder", path: real });
    return steps;
  },
};

export const deliveryModes: Record<DeliveryMode, DeliveryModeAdapter> = { link: linkMode, copy: copyMode };

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

const LINKS_EXCLUDE_BLOCK = {
  start: "# Dark Matter Links (managed by Dark Matter; edits inside this block are replaced)",
  end: "# End of Dark Matter Links",
};

/** The info/exclude block Personal Project MCP Servers (#38) keep their Project config files in. */
export const MCP_EXCLUDE_BLOCK = {
  start: "# Dark Matter Personal MCP Servers (managed by Dark Matter; edits inside this block are replaced)",
  end: "# End of Dark Matter Personal MCP Servers",
};

/**
 * `text` with one of Dark Matter's blocks (the Links one by default) replaced by `paths`
 * (removed when empty); everything else kept as is.
 */
export const withExcludeBlock = (
  text: string,
  paths: readonly string[],
  { start: BLOCK_START, end: BLOCK_END } = LINKS_EXCLUDE_BLOCK,
): string => {
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
  /** The Project's `skills-lock.json` and its new text, when its Copies change it. */
  lock: { path: string; text: string } | null;
}

export interface DeliveryOptions {
  /** The record before this change (default: `record`): which Copies are Dark Matter's, and the mode a dropped key had. */
  previous?: ProjectRecord;
  /** Copies to replace with the Library's version (Update, Take Library version). */
  refresh?: readonly string[];
  /** Keys whose committed folder at `.agents/skills/<name>` becomes their Copy (fulfilling `skills-lock.json`). */
  claim?: readonly string[];
}

const hashOrEmpty = (folder: string) => cachedSkillFolderHash(folder).catch(() => "");

/** How a delivered Copy compares with its lock entry (edited in the repo?) and the Library (moved on?). */
export const copyStateOf = async (
  copyFolder: string,
  entry: { computedHash: string; commit?: string | undefined } | null,
  library: { folder: string; commit?: string | undefined },
): Promise<CopyState> => {
  const hash = await hashOrEmpty(copyFolder);
  if (!entry || hash !== entry.computedHash) return "modifiedInRepo";
  if (entry.commit && library.commit && entry.commit !== library.commit) return "outdated";
  return hash === (await hashOrEmpty(library.folder)) ? "current" : "outdated";
};

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
  { previous = record, refresh = [], claim = [] }: DeliveryOptions = {},
): Promise<DeliveryPlan> => {
  const chosen = deliveryFolders(record.agents);
  const every = allDeliveryFolders();
  const others = every.filter((folder) => !chosen.includes(folder));
  const keys = Object.keys(record.skills).sort();
  const names = new Map<string, string>();
  for (const key of [...keys, ...removed]) names.set(key, await deliveredName(library, key));
  const previousMode = (key: string) => previous.skills[key]?.mode;
  const target = async (key: string, mode: DeliveryMode): Promise<DeliveryTarget> => {
    const folder = library.folder(key);
    return {
      project,
      key,
      name: names.get(key) ?? splitKey(key).name,
      source: mode === "copy" ? await realpath(folder).catch(() => folder) : folder,
      claimed: previousMode(key) === "copy" || claim.includes(key),
      refresh: refresh.includes(key),
    };
  };

  const steps: PlanStep[] = [];
  const excluded: string[] = [];
  const skills: ProjectSkill[] = [];
  /** Copy names whose lock entry goes, and Copies freshly written from the Library. */
  const unlocked: string[] = [];
  const written: { key: string; name: string; source: string }[] = [];
  const track = (it: DeliveryTarget, planned: PlanStep[]) => {
    const real = join(project, COPY_FOLDER, it.name);
    if (planned.some((step) => step.kind === "copy" && step.to === real)) written.push(it);
    else if (planned.some((step) => step.kind === "removeFolder" && step.path === real)) unlocked.push(it.name);
    steps.push(...planned);
  };
  // Deliveries that go first: dropped keys, and the old mode of a key whose mode changed.
  for (const key of removed) {
    const mode = previousMode(key) ?? "link";
    track(await target(key, mode), await deliveryModes[mode].plan(await target(key, mode), [], every));
  }
  for (const key of keys) {
    const before = previousMode(key);
    if (before && before !== record.skills[key]?.mode)
      track(await target(key, before), await deliveryModes[before].plan(await target(key, before), [], every));
  }
  const freed = new Set(
    steps.flatMap((step) => (step.kind === "removeLink" || step.kind === "removeFolder" ? [step.path] : [])),
  );
  const copies: { it: DeliveryTarget; index: number }[] = [];
  const keptCopies: { it: DeliveryTarget; index: number }[] = [];
  for (const key of keys) {
    const wanted = record.skills[key];
    if (!wanted) continue;
    const mode = deliveryModes[wanted.mode];
    const it = await target(key, wanted.mode);
    if (previousMode(key) !== wanted.mode && !claim.includes(key)) it.claimed = false;
    const conflictsWith = keys.filter((other) => other !== key && names.get(other) === it.name);
    const status = conflictsWith.length > 0 ? "nameConflict" : wanted.on ? "on" : "off";
    if (status === "nameConflict") {
      // Leave what's there; a Link is only dropped from folders the Project's Agents no longer use.
      if (wanted.mode === "link") steps.push(...(await mode.plan(it, [], others)));
      for (const folder of chosen)
        if (mode.excluded && (await mode.isDelivered(join(project, folder, it.name), it)))
          excluded.push(join(folder, it.name));
    } else if (status === "on") {
      track(it, await mode.plan(it, chosen, others, freed));
      if (mode.excluded) excluded.push(...chosen.map((folder) => join(folder, it.name)));
    } else track(it, await mode.plan(it, [], every));
    const { namespace } = splitKey(key);
    if (wanted.mode === "copy" && status === "on") copies.push({ it, index: skills.length });
    // A Copy left in place by a Name Conflict still has its state, so Resolve can guard its edits.
    if (wanted.mode === "copy" && status === "nameConflict" && wanted.on && it.claimed !== false)
      keptCopies.push({ it, index: skills.length });
    skills.push({
      key,
      namespace,
      name: it.name,
      mode: wanted.mode,
      on: wanted.on,
      status,
      conflictsWith,
      paths:
        wanted.mode === "copy"
          ? [...new Set([COPY_FOLDER, ...chosen])].sort().map((folder) => join(folder, it.name))
          : chosen.map((folder) => join(folder, it.name)),
    });
  }

  let lock: DeliveryPlan["lock"] = null;
  const usesCopies = [...keys, ...removed].some(
    (key) => record.skills[key]?.mode === "copy" || previousMode(key) === "copy",
  );
  if (usesCopies) {
    const current = await readProjectLock(project);
    const next: ProjectLock = { version: Math.max(current?.version ?? 2, 2), skills: { ...current?.skills } };
    const entryFor = (key: string, name: string, hash: string) =>
      copyLockEntry(key, library.lock.value.skills[key], name, hash);
    for (const name of unlocked) delete next.skills[name];
    for (const { key, name, source } of written) next.skills[name] = entryFor(key, name, await hashOrEmpty(source));
    for (const { it, index } of copies) {
      const skill = skills[index];
      if (!skill) continue;
      if (written.some((copy) => copy.key === it.key)) {
        skill.copyState = "current";
        continue;
      }
      const folder = join(project, COPY_FOLDER, it.name);
      if (!next.skills[it.name]) next.skills[it.name] = entryFor(it.key, it.name, await hashOrEmpty(folder));
      skill.copyState = await copyStateOf(folder, lockEntry(next, it.name), {
        folder: it.source,
        commit: library.lock.value.skills[it.key]?.commit,
      });
    }
    for (const { it, index } of keptCopies) {
      const skill = skills[index];
      const entry = current ? lockEntry(current, it.name) : null;
      if (!skill || !entry) continue;
      skill.copyState = await copyStateOf(join(project, COPY_FOLDER, it.name), entry, {
        folder: it.source,
        commit: library.lock.value.skills[it.key]?.commit,
      });
    }
    const text = projectLockText(next);
    const before = current ? projectLockText(current) : null;
    if (text !== before && (current || Object.keys(next.skills).length > 0)) {
      lock = { path: projectLockPath(project), text };
      steps.push({ kind: "editFile", path: lock.path, change: "record the Project's Copies in skills-lock.json" });
    }
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
  return { steps, skills, exclude, lock };
};

/** Carries out a delivery plan. Taken targets are checked before anything is written. */
export const applyDelivery = async (
  plan: DeliveryPlan,
  context: { home: string; libraryHome: string; wrote: Wrote },
) => {
  const rel = (path: string) => homeRelative(context.home, path);
  const relative = plan.steps.map((step): PlanStep => {
    if (step.kind === "createLink" || step.kind === "removeLink" || step.kind === "removeFolder")
      return { ...step, path: rel(step.path) };
    if (step.kind === "copy") return { ...step, from: rel(step.from), to: rel(step.to) };
    return step;
  });
  const files = [plan.exclude, plan.lock].filter((file) => file !== null);
  await applySteps(relative, {
    ...context,
    editFile: async (step) => {
      const file = files.find((found) => found.path === step.path);
      if (!file) return [];
      await mkdir(dirname(file.path), { recursive: true });
      await writeFileAtomic(file.path, file.text);
      return [file.path];
    },
  });
};
