import type { AgentCard, Inbox, InboxFolderGroup, ScanResult } from "@dark-matter/contracts";
import { type AgentPathEnv, agentAdapters } from "./agents";
import { homeRelative } from "./home-path";

/**
 * The Inbox from the latest Scan: Global Skills grouped by Agent folder, minus
 * ignored ones, plus the number of Suggested Projects waiting.
 */
export const inboxFrom = (
  scan: ScanResult | null,
  ignored: readonly string[],
  env: AgentPathEnv,
  suggestedProjects = 0,
): Inbox => {
  const skipped = new Set(ignored);
  const all = scan?.globalSkills ?? [];
  const waiting = all.filter((finding) => !skipped.has(finding.id));
  const groups = new Map<string, InboxFolderGroup>();
  for (const finding of waiting) {
    const group = groups.get(finding.folder) ?? {
      folder: finding.folder,
      agents: agentAdapters
        .filter((adapter) =>
          adapter.skills.globalFolders(env).some((folder) => homeRelative(env.home, folder.path) === finding.folder),
        )
        .map((adapter) => adapter.id),
      findings: [],
    };
    group.findings.push(finding);
    groups.set(finding.folder, group);
  }
  return {
    count: waiting.length + suggestedProjects,
    globalSkills: [...groups.values()],
    ignoredCount: all.length - waiting.length,
    suggestedProjects,
  };
};

/** One card per v1 Agent; counts are null until the first Scan. */
export const agentCards = (scan: ScanResult | null, env: AgentPathEnv): AgentCard[] =>
  agentAdapters.map((adapter) => {
    const seen = scan?.agents.find((agent) => agent.id === adapter.id);
    const own = adapter.skills.globalFolders(env)[0];
    return {
      id: adapter.id,
      name: adapter.name,
      detected: seen?.detected ?? null,
      globalSkillFolder: own ? homeRelative(env.home, own.path) : "",
      globalSkillCount: seen?.globalSkillCount ?? null,
    };
  });
