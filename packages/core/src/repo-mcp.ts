import type { AgentId, ProjectMcpEntry, ProjectRecord, RepoMcpServer, RepoMcpServers } from "@dark-matter/contracts";
import { type AgentPathEnv, agentAdapters } from "./agents";
import { readConfigText } from "./config-edit";
import { homeRelative } from "./home-path";
import { type AgentMcp, entriesOf, type McpEntry, mcpConfigEdits } from "./mcp-agents";
import { isTracked } from "./mcp-delivery";
import { maskSecrets } from "./mcp-secrets";
import { toSortedJson } from "./sorted-json";

/** An MCP entry found in a Project's config that Dark Matter didn't write (#39), with what Adopt needs. */
export interface ProjectMcpFinding {
  id: string;
  project: string;
  agent: AgentId;
  mcp: AgentMcp;
  /** Absolute. */
  file: string;
  /** Committed by git: a Vendored MCP Server, left alone. */
  tracked: boolean;
  entry: McpEntry;
}

export const PROJECT_MCP_PREFIX = "project-mcp:";

const projectMcpId = (agent: AgentId, project: string, name: string) =>
  `${PROJECT_MCP_PREFIX}${agent}:${project}:${name}`;

/**
 * Every MCP entry in a Project's config files (each Agent's Personal and
 * Shared locations, Claude Code's local scope included) that isn't one Dark
 * Matter delivered for the Project's record. Unreadable files are skipped.
 */
export const projectMcpFindings = async (
  env: AgentPathEnv,
  project: string,
  record: ProjectRecord,
): Promise<ProjectMcpFinding[]> => {
  const ours = new Set(
    Object.values(record.mcpServers ?? {}).flatMap((server) =>
      server.delivered.map((entry) => toSortedJson([entry.agent, entry.file, entry.at])),
    ),
  );
  const findings: ProjectMcpFinding[] = [];
  for (const adapter of agentAdapters) {
    const mcp = adapter.mcp;
    if (!mcp) continue;
    const targets = [await mcp.personal(project, env), await mcp.shared(project, env)];
    const seen = new Set<string>();
    for (const target of targets) {
      if (seen.has(target.file)) continue;
      seen.add(target.file);
      const text = await readConfigText(target.file);
      if (text === null) continue;
      let doc: unknown;
      try {
        doc = mcpConfigEdits[mcp.format].read(text, target.file);
      } catch {
        continue;
      }
      const at = target.at(doc, "").slice(0, -1);
      const map = at.reduce<unknown>(
        (value, key) =>
          typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined,
        doc,
      );
      const tracked = target.projectFile !== null && (await isTracked(project, target.projectFile));
      const file = homeRelative(env.home, target.file);
      for (const entry of entriesOf(map, at, (raw) => mcp.read(raw))) {
        if (ours.has(toSortedJson([adapter.id, file, entry.at]))) continue;
        findings.push({
          id: projectMcpId(adapter.id, project, entry.name),
          project,
          agent: adapter.id,
          mcp,
          file: target.file,
          tracked,
          entry,
        });
      }
    }
  }
  return findings;
};

/** The Project page's view: Vendored (committed) and untracked MCP entries, inline secrets masked. */
export const repoMcpServers = async (
  env: AgentPathEnv,
  project: string,
  record: ProjectRecord,
): Promise<RepoMcpServers> => {
  const view = (finding: ProjectMcpFinding): RepoMcpServer => ({
    id: finding.id,
    agent: finding.agent,
    name: finding.entry.name,
    file: homeRelative(env.home, finding.file),
    definition: maskSecrets(finding.entry.name, finding.entry.definition).definition,
  });
  const findings = await projectMcpFindings(env, project, record);
  return {
    vendored: findings.filter((finding) => finding.tracked).map(view),
    untracked: findings.filter((finding) => !finding.tracked).map(view),
  };
};

/** What a Scan records for a Project (#39 carry-over): every entry Dark Matter didn't deliver, inline secrets masked. */
export const projectMcpEntries = async (
  env: AgentPathEnv,
  project: string,
  record: ProjectRecord,
): Promise<ProjectMcpEntry[]> =>
  (await projectMcpFindings(env, project, record)).map((finding) => ({
    id: finding.id,
    project,
    agent: finding.agent,
    name: finding.entry.name,
    file: homeRelative(env.home, finding.file),
    tracked: finding.tracked,
    definition: maskSecrets(finding.entry.name, finding.entry.definition).definition,
  }));
