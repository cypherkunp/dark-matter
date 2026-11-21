import { basename, sep } from "node:path";
import type { InboxProjectGroup, ScanResult, UntrackedSkill } from "@dark-matter/contracts";
import type { AgentPathEnv } from "./agents";
import { homeRelative } from "./home-path";

const within = (path: string, root: string) => path === root || path.startsWith(root + sep);

/**
 * Untracked Project Skills (#10 point 7) from the latest Scan: entries in a
 * confirmed Project's skill folders that git doesn't track (those are
 * Vendored) and that aren't Dark Matter's own deliveries (they resolve into
 * the Library, or to a Library Local Source's folder). One finding per real
 * folder, however many entries reach it.
 */
export const untrackedSkills = (
  scan: ScanResult | null,
  env: AgentPathEnv,
  libraryHome: string,
  localSources: readonly string[] = [],
): InboxProjectGroup[] => {
  const rel = (path: string) => homeRelative(env.home, path);
  const groups: InboxProjectGroup[] = [];
  for (const project of scan?.projects ?? []) {
    const byReal = new Map<string, typeof project.skills>();
    for (const entry of project.skills) {
      if (within(entry.realPath, libraryHome) || localSources.includes(entry.realPath)) continue;
      byReal.set(entry.realPath, [...(byReal.get(entry.realPath) ?? []), entry]);
    }
    const findings: UntrackedSkill[] = [];
    for (const [realPath, entries] of byReal) {
      const [first] = entries;
      if (!first || entries.some((entry) => entry.tracked)) continue;
      // The entry holding the real folder first, then the ones linking to it.
      const ordered = [...entries].sort(
        (a, b) => Number(a.symlink) - Number(b.symlink) || a.path.localeCompare(b.path),
      );
      findings.push({
        id: `untracked-skill:${rel(realPath)}`,
        project: project.path,
        name: first.name,
        description: first.description,
        realPath: rel(realPath),
        locations: ordered.map((entry) => ({ folder: entry.folder, path: rel(entry.path), symlink: entry.symlink })),
        localSource: !within(realPath, project.path),
      });
    }
    findings.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    if (findings.length > 0) groups.push({ project: project.path, name: basename(project.path), findings });
  }
  return groups.sort((a, b) => a.name.localeCompare(b.name) || a.project.localeCompare(b.project));
};
