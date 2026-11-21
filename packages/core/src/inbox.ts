import type {
  AgentCard,
  Inbox,
  InboxDriftGroup,
  InboxFolderGroup,
  InboxManagedGroup,
  InboxManagedMcpGroup,
  InboxMcpGroup,
  InboxNewSkillsGroup,
  InboxProjectGroup,
  ScanResult,
} from "@dark-matter/contracts";
import { type AgentPathEnv, agentAdapters } from "./agents";
import { homeRelative } from "./home-path";

/**
 * The Inbox from the latest Scan: Global Skills grouped by Agent folder and
 * Agent-managed Skills that are still on grouped by Agent, minus ignored ones,
 * plus the number of Suggested Projects waiting.
 */
export const inboxFrom = (
  scan: ScanResult | null,
  ignored: readonly string[],
  env: AgentPathEnv,
  suggestedProjects = 0,
  untracked: readonly InboxProjectGroup[] = [],
  driftGroups: readonly InboxDriftGroup[] = [],
  newSkillGroups: readonly InboxNewSkillsGroup[] = [],
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
  const managed = (scan?.managedSkills ?? []).filter((finding) => !finding.off);
  const managedWaiting = managed.filter((finding) => !skipped.has(finding.id));
  const managedSkills: InboxManagedGroup[] = agentAdapters
    .map((adapter) => ({
      agent: adapter.id,
      findings: managedWaiting.filter((finding) => finding.agent === adapter.id),
    }))
    .filter((group) => group.findings.length > 0);
  const untrackedSkills = untracked
    .map((group) => ({ ...group, findings: group.findings.filter((finding) => !skipped.has(finding.id)) }))
    .filter((group) => group.findings.length > 0);
  const untrackedAll = untracked.reduce((sum, group) => sum + group.findings.length, 0);
  const untrackedWaiting = untrackedSkills.reduce((sum, group) => sum + group.findings.length, 0);
  const mcp = scan?.globalMcpServers ?? [];
  const mcpWaiting = mcp.filter((finding) => !skipped.has(finding.id));
  const mcpServers: InboxMcpGroup[] = agentAdapters.flatMap((adapter) => {
    const findings = mcpWaiting.filter((finding) => finding.agent === adapter.id);
    const first = findings[0];
    return first ? [{ agent: adapter.id, file: first.file, findings }] : [];
  });
  const drift = driftGroups
    .map((group) => ({ ...group, findings: group.findings.filter((finding) => !skipped.has(finding.id)) }))
    .filter((group) => group.findings.length > 0);
  const driftAll = driftGroups.reduce((sum, group) => sum + group.findings.length, 0);
  const driftWaiting = drift.reduce((sum, group) => sum + group.findings.length, 0);
  const newSkills = newSkillGroups
    .map((group) => ({ ...group, findings: group.findings.filter((finding) => !skipped.has(finding.id)) }))
    .filter((group) => group.findings.length > 0);
  const newSkillsAll = newSkillGroups.reduce((sum, group) => sum + group.findings.length, 0);
  const newSkillsWaiting = newSkills.reduce((sum, group) => sum + group.findings.length, 0);
  const managedMcp = (scan?.managedMcpServers ?? []).filter((finding) => !finding.off);
  const managedMcpWaiting = managedMcp.filter((finding) => !skipped.has(finding.id));
  const managedMcpServers: InboxManagedMcpGroup[] = agentAdapters.flatMap((adapter) => {
    const findings = managedMcpWaiting.filter((finding) => finding.agent === adapter.id);
    return findings.length > 0 ? [{ agent: adapter.id, findings }] : [];
  });
  return {
    count:
      waiting.length +
      managedWaiting.length +
      mcpWaiting.length +
      untrackedWaiting +
      managedMcpWaiting.length +
      driftWaiting +
      newSkillsWaiting +
      suggestedProjects,
    drift,
    untrackedSkills,
    globalSkills: [...groups.values()],
    managedSkills,
    ignoredCount:
      all.length -
      waiting.length +
      managed.length -
      managedWaiting.length +
      mcp.length -
      mcpWaiting.length +
      untrackedAll -
      untrackedWaiting +
      managedMcp.length -
      managedMcpWaiting.length +
      driftAll -
      driftWaiting +
      newSkillsAll -
      newSkillsWaiting,
    suggestedProjects,
    mcpServers,
    managedMcpServers,
    newSkills,
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
      managedSkillCount: seen?.managedSkillCount ?? null,
      mcpConfig: seen?.mcpConfig ?? null,
      globalMcpServerCount: adapter.mcp ? (seen?.globalMcpServerCount ?? null) : null,
      managedMcpServerCount: adapter.managedMcp ? (seen?.managedMcpServerCount ?? null) : null,
      managedMcpNotes: [...(adapter.managedMcp?.notes ?? [])],
    };
  });
