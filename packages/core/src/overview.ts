import type { DatabaseSync } from "node:sqlite";
import type { DriftFinding, Inbox, Overview, OverviewAlert, ProjectSkill, ScanResult } from "@dark-matter/contracts";
import { agentAdapters } from "./agents";
import { homeRelative } from "./home-path";

export interface OverviewOptions {
  home: string;
  cache: DatabaseSync;
  now: () => Date;
  latestScan: () => ScanResult | null;
  inbox: () => Promise<Inbox>;
  /** Confirmed Projects, by absolute path. */
  projectPaths: () => string[];
  /** A Project's Project Skills with their status and Copy state. */
  projectSkills: (path: string) => Promise<ProjectSkill[]>;
  /** Library Skills with an upstream update waiting, from the last checks (#33). */
  libraryUpdates: () => Promise<number>;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** "a, b, c and 2 more": a detail line that stays one line. */
const names = (all: readonly { name: string }[]) => {
  const shown = all.slice(0, 3).map((finding) => finding.name);
  const more = all.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
};

const agentName = (id: string) => agentAdapters.find((adapter) => adapter.id === id)?.name ?? id;

const projectPage = (path: string) => `/project?path=${encodeURIComponent(path)}`;

const driftIssue = (finding: DriftFinding): string => {
  const name = finding.name ?? finding.key ?? "A Skill";
  const what = finding.mode === "copy" ? "Copy" : "Link";
  switch (finding.kind) {
    case "missing":
      return `${name} ${what} deleted`;
    case "replaced":
      return `${name} ${what} replaced`;
    case "lockAdded":
      return `${name} added to skills-lock.json`;
    case "lockRemoved":
      return `${name} removed from skills-lock.json`;
    case "projectGone":
      return "Project folder gone";
  }
};

const SCHEMA = `CREATE TABLE IF NOT EXISTS finding_seen (id TEXT PRIMARY KEY, first_seen TEXT NOT NULL)`;

/**
 * The overview screens' stat cards and amber alerts (#45), computed in one
 * place from the latest Scan, the Inbox (drift included) and the Projects.
 * When each finding was first seen is kept in the cache; a finding that goes
 * away is forgotten, so if it comes back it's new again.
 */
export class OverviewService {
  constructor(private readonly options: OverviewOptions) {
    options.cache.exec(SCHEMA);
  }

  /** Records findings not seen before and forgets ones that went away; returns each one's first sighting. */
  #firstSeen(ids: readonly string[]): Map<string, string> {
    const { cache, now } = this.options;
    const at = now().toISOString();
    const insert = cache.prepare("INSERT OR IGNORE INTO finding_seen (id, first_seen) VALUES (?, ?)");
    for (const id of ids) insert.run(id, at);
    const rows = cache.prepare("SELECT id, first_seen FROM finding_seen").all() as { id: string; first_seen: string }[];
    const wanted = new Set(ids);
    const seen = new Map<string, string>();
    const forget = cache.prepare("DELETE FROM finding_seen WHERE id = ?");
    for (const row of rows) {
      if (wanted.has(row.id)) seen.set(row.id, row.first_seen);
      else forget.run(row.id);
    }
    return seen;
  }

  async get(): Promise<Overview> {
    const { home, latestScan, inbox: readInbox, projectPaths, projectSkills } = this.options;
    const inbox = await readInbox();
    const libraryUpdates = await this.options.libraryUpdates().catch(() => 0);
    let on = 0;
    let outdated = libraryUpdates;
    let nameConflicts = 0;
    let firstOutdated: string | null = null;
    let firstConflict: string | null = null;
    for (const path of [...projectPaths()].sort()) {
      const skills = await projectSkills(path).catch(() => []);
      on += skills.filter((skill) => skill.status === "on").length;
      const stale = skills.filter((skill) => skill.copyState === "outdated").length;
      outdated += stale;
      if (stale > 0) firstOutdated ??= path;
      // One Name Conflict per delivered name, however many Skills want it.
      const conflicts = new Set(skills.filter((skill) => skill.status === "nameConflict").map((skill) => skill.name));
      nameConflicts += conflicts.size;
      if (conflicts.size > 0) firstConflict ??= path;
    }

    const drafts: (Omit<OverviewAlert, "firstSeenAt"> & { findings: string[] })[] = [];
    for (const group of inbox.drift) {
      for (const finding of group.findings) {
        drafts.push({
          id: finding.id,
          subject: group.name,
          issue: driftIssue(finding),
          detail: finding.paths.length > 0 ? finding.paths.join(", ") : homeRelative(home, group.project),
          path: "/inbox",
          findings: [finding.id],
        });
      }
    }
    for (const group of inbox.globalSkills) {
      drafts.push({
        id: `global-skills:${group.folder}`,
        subject: group.folder,
        issue: `${plural(group.findings.length, "Global Skill")} found`,
        detail: names(group.findings),
        path: "/inbox",
        findings: group.findings.map((finding) => finding.id),
      });
    }
    for (const group of inbox.untrackedSkills) {
      drafts.push({
        id: `untracked-skills:${group.project}`,
        subject: group.name,
        issue: `${plural(group.findings.length, "untracked Project Skill")}`,
        detail: names(group.findings),
        path: "/inbox",
        findings: group.findings.map((finding) => finding.id),
      });
    }
    for (const group of inbox.managedSkills) {
      drafts.push({
        id: `managed-skills:${group.agent}`,
        subject: agentName(group.agent),
        issue: `${plural(group.findings.length, "Agent-managed Skill")} on`,
        detail: names(group.findings),
        path: "/inbox",
        findings: group.findings.map((finding) => finding.id),
      });
    }
    for (const group of inbox.mcpServers) {
      drafts.push({
        id: `mcp-servers:${group.file}`,
        subject: group.file,
        issue: `${plural(group.findings.length, "Global MCP Server")} found`,
        detail: names(group.findings),
        path: "/inbox",
        findings: group.findings.map((finding) => finding.id),
      });
    }
    for (const group of inbox.managedMcpServers) {
      drafts.push({
        id: `managed-mcp-servers:${group.agent}`,
        subject: agentName(group.agent),
        issue: `${plural(group.findings.length, "Agent-managed MCP Server")} on`,
        detail: names(group.findings),
        path: "/inbox",
        findings: group.findings.map((finding) => finding.id),
      });
    }
    if (inbox.suggestedProjects > 0) {
      drafts.push({
        id: "suggested-projects",
        subject: "Projects",
        issue: `${plural(inbox.suggestedProjects, "Suggested Project")} waiting`,
        detail: "Found in your Agents' history: confirm or dismiss them",
        path: "/projects/suggested",
        findings: ["suggested-projects"],
      });
    }
    const seen = this.#firstSeen(drafts.flatMap((draft) => draft.findings));
    const fallback = this.options.now().toISOString();
    const alerts = drafts.map(({ findings, ...alert }) => ({
      ...alert,
      firstSeenAt: findings.map((id) => seen.get(id) ?? fallback).sort()[0] ?? fallback,
    }));

    return {
      stats: {
        projectSkillsOn: { count: on, path: "/library" },
        globalSkills: { count: latestScan()?.globalSkills.length ?? null, path: "/inbox" },
        outdated: {
          count: outdated,
          // Library updates first: applying one also marks the Copies that follow it.
          path: libraryUpdates > 0 ? "/library/updates" : firstOutdated ? projectPage(firstOutdated) : "/library",
        },
        nameConflicts: { count: nameConflicts, path: firstConflict ? projectPage(firstConflict) : "/library" },
      },
      alerts,
    };
  }
}
