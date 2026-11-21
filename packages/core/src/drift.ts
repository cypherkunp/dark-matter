import { realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type ActivitySubject,
  type ClientKind,
  type DeliveryMode,
  type DriftAction,
  type DriftFinding,
  type InboxDriftGroup,
  type ProjectRecord,
  type ProjectsFile,
  UnknownFinding,
} from "@dark-matter/contracts";
import type { ActivityLog } from "./activity";
import { copyMode, type DeliveryTarget, deliveredName, linkMode } from "./delivery";
import type { EventBus } from "./events";
import { lstatOrNull } from "./fs-util";
import { homeRelative } from "./home-path";
import type { Library } from "./library";
import type { OwnedFile } from "./owned-file";
import { applySteps } from "./plan";
import { COPY_FOLDER, lockEntry, readProjectLock } from "./project-lock";
import type { ProjectSkillService } from "./project-skills";
import { deliveryFolders } from "./projects";
import { type LockImporter, lockedSkills } from "./repo-skills";
import { writeTrashed } from "./trash";

export interface DriftOptions {
  home: string;
  libraryHome: string;
  library: Library;
  projects: OwnedFile<typeof ProjectsFile>;
  projectSkills: ProjectSkillService;
  activity: ActivityLog;
  bus: EventBus;
  importer: () => LockImporter | null;
  /** `project.remove`: Accept for a Project whose folder is gone. */
  removeProject(path: string, client: ClientKind): Promise<void>;
  /** `project.fulfilLock`: Accept for a teammate's new lock entry. */
  fulfilLock(input: { path: string; names: string[] }, client: ClientKind): Promise<unknown>;
}

const finding = (
  project: string,
  fields: Omit<DriftFinding, "project" | "id" | "key" | "name" | "mode"> &
    Partial<Pick<DriftFinding, "key" | "name" | "mode">> & { id?: string },
): DriftFinding => ({
  id: fields.id ?? `drift:${project}`,
  kind: fields.kind,
  project,
  key: fields.key ?? null,
  name: fields.name ?? null,
  mode: fields.mode ?? null,
  paths: fields.paths,
  actions: fields.actions,
});

/**
 * Drift (#42): where owned intent (`projects.json`) and the disk disagree.
 * Findings are computed on demand from the disk, so they are always current;
 * the watcher pushes `inbox`/`project` invalidations when Project folders
 * change. Restore re-applies intent; Accept makes `projects.json` match disk.
 */
export class Drift {
  constructor(private readonly options: DriftOptions) {}

  async groups(): Promise<InboxDriftGroup[]> {
    const groups: InboxDriftGroup[] = [];
    const projects = Object.entries(this.options.projects.value.projects).sort(([a], [b]) => a.localeCompare(b));
    for (const [path, record] of projects) {
      const findings = await this.#findings(path, record).catch(() => []);
      if (findings.length > 0) groups.push({ project: path, name: basename(path), findings });
    }
    return groups;
  }

  async #findings(path: string, record: ProjectRecord): Promise<DriftFinding[]> {
    if (!(await lstatOrNull(path))?.isDirectory())
      return [finding(path, { kind: "projectGone", paths: [], actions: ["accept"] })];
    const { library } = this.options;
    const found: DriftFinding[] = [];
    const keys = Object.keys(record.skills).sort();
    const names = new Map<string, string>();
    for (const key of keys) names.set(key, await deliveredName(library, key));
    const lock = await readProjectLock(path).catch(() => null);
    const folders = deliveryFolders(record.agents);
    for (const key of keys) {
      const wanted = record.skills[key];
      const name = names.get(key) ?? key;
      // Off delivers nothing, and a Name Conflict is shown on its own until Resolve.
      if (!wanted?.on || keys.some((other) => other !== key && names.get(other) === name)) continue;
      const base = { id: `drift:${path}:${key}`, key, name, mode: wanted.mode };
      if (wanted.mode === "copy" && !lockEntry(lock, name)) {
        found.push(
          finding(path, {
            ...base,
            kind: "lockRemoved",
            paths: ["skills-lock.json"],
            actions: actionsFor("lockRemoved", "copy"),
          }),
        );
        continue;
      }
      const target = await this.#target(path, key, name, wanted.mode);
      const mode = wanted.mode === "copy" ? copyMode : linkMode;
      const places = wanted.mode === "copy" ? [...new Set([COPY_FOLDER, ...folders])] : folders;
      const missing: string[] = [];
      const replaced: string[] = [];
      for (const folder of places) {
        const at = join(path, folder, name);
        if (await mode.isDelivered(at, target)) continue;
        if (await lstatOrNull(at)) replaced.push(join(folder, name));
        else missing.push(join(folder, name));
      }
      if (missing.length + replaced.length === 0) continue;
      const kind = replaced.length > 0 ? "replaced" : "missing";
      found.push(
        finding(path, {
          ...base,
          kind,
          paths: [...replaced, ...missing].sort(),
          actions: actionsFor(kind, wanted.mode),
        }),
      );
    }
    const importer = this.options.importer();
    for (const { skill } of await lockedSkills(library, path, record, importer)) {
      found.push(
        finding(path, {
          id: `drift:${path}:lock:${skill.name}`,
          kind: "lockAdded",
          key: skill.key,
          name: skill.name,
          mode: "copy",
          paths: ["skills-lock.json"],
          actions: skill.key || (importer && !skill.message) ? ["accept"] : [],
        }),
      );
    }
    return found;
  }

  async #target(project: string, key: string, name: string, mode: DeliveryMode): Promise<DeliveryTarget> {
    const folder = this.options.library.folder(key);
    return {
      project,
      key,
      name,
      source: mode === "copy" ? await realpath(folder).catch(() => folder) : folder,
      claimed: true,
    };
  }

  async #find(id: string, action: DriftAction): Promise<DriftFinding> {
    for (const group of await this.groups()) {
      const found = group.findings.find((candidate) => candidate.id === id);
      if (found?.actions.includes(action)) return found;
    }
    throw new UnknownFinding(id);
  }

  #track(
    client: ClientKind,
    action: string,
    found: DriftFinding,
    run: (wrote: (path: string | null) => void) => Promise<void>,
  ) {
    const subjects: ActivitySubject[] = [
      { kind: "finding", id: found.id },
      { kind: "project", id: found.project },
      ...(found.key ? [{ kind: "skill" as const, id: found.key }] : []),
    ];
    return this.options.activity
      .track({ client, action, subjects }, run)
      .finally(() => this.options.bus.publish({ type: "invalidate", domains: ["inbox", "project"] }));
  }

  async restore(id: string, client: ClientKind): Promise<void> {
    const found = await this.#find(id, "restore");
    const { home, libraryHome, projectSkills } = this.options;
    await this.#track(client, "drift.restore", found, async (wrote) => {
      await projectSkills.reconcile(found.project, wrote, async (record) => {
        if (found.kind === "replaced") {
          // What took the delivery's place goes to trash/, never deleted.
          const now = new Date().toISOString();
          const stamp = now.replaceAll(":", "-");
          const into = join(libraryHome, "trash", `${stamp}-drift`);
          let recorded = false;
          const rel = (abs: string) => homeRelative(home, abs);
          for (const path of found.paths) {
            const at = join(found.project, path);
            if (
              await mode(found).isDelivered(
                at,
                await this.#target(found.project, found.key ?? "", found.name ?? "", found.mode ?? "link"),
              )
            )
              continue;
            const to = join(into, basename(found.project), path);
            await applySteps([{ kind: "move", from: rel(at), to: rel(to) }], {
              home,
              libraryHome,
              wrote,
              editFile: async () => [],
            });
            // Recorded like a deleted Skill, so the daily purge removes it after the retention (review #14).
            if (!recorded) {
              await writeTrashed(into, { key: `drift:${found.project}`, deletedAt: now, entry: null, kind: "drift" });
              recorded = true;
            }
          }
        }
        return { next: record };
      });
    });
  }

  async accept(id: string, client: ClientKind): Promise<void> {
    const found = await this.#find(id, "accept");
    if (found.kind === "projectGone") return this.options.removeProject(found.project, client);
    if (found.kind === "lockAdded" && found.name)
      return void (await this.options.fulfilLock({ path: found.project, names: [found.name] }, client));
    const key = found.key ?? "";
    await this.#track(client, "drift.accept", found, async (wrote) => {
      await this.options.projectSkills.reconcile(found.project, wrote, async (record) => {
        if (found.kind === "missing") {
          // A deleted Link: the Project remembers the Skill, Off.
          return { next: { ...record, skills: { ...record.skills, [key]: { mode: "link", on: false } } } };
        }
        // Replaced: the Project forgets the Skill and what took its place stays.
        // Removed from the lock by a teammate: the Project forgets the Copy and its own symlinks.
        const { [key]: _gone, ...skills } = record.skills;
        return { next: { ...record, skills }, removed: [key] };
      });
    });
  }
}

const mode = (found: DriftFinding) => (found.mode === "copy" ? copyMode : linkMode);

/** Accept for a Copy that went missing or was replaced in the repo isn't offered: Restore or Ignore it. */
const actionsFor = (kind: DriftFinding["kind"], deliveryMode: DeliveryMode): DriftAction[] =>
  deliveryMode === "copy" && kind !== "lockRemoved" ? ["restore"] : ["restore", "accept"];
