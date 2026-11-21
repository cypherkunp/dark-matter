import type { InboxDriftGroup, SettingsFile } from "@dark-matter/contracts";
import type { OwnedFile } from "./owned-file";
import type { Scans } from "./scans";
import type { DailyJob } from "./scheduler";

export interface ScanJobOptions {
  scans: Scans;
  settings: OwnedFile<typeof SettingsFile>;
  /** Drift findings as the Inbox shows them (computed from disk). */
  drift: () => Promise<readonly InboxDriftGroup[]>;
}

interface Found {
  id: string;
  label: string;
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/** The notification for what's new, by kind; a single kind keeps its own wording. */
const message = (skills: Found[], servers: Found[], drift: Found[]) => {
  const total = skills.length + servers.length + drift.length;
  const names = (found: Found[]) => found.map((item) => item.label).join(", ");
  const review = `Review ${total === 1 ? "it" : "them"} in the Inbox.`;
  const kinds = [skills, servers, drift].filter((found) => found.length > 0);
  if (kinds.length > 1) {
    const parts = [
      skills.length > 0 && `${plural(skills.length, "Global Skill", "Global Skills")}: ${names(skills)}`,
      servers.length > 0 && `${plural(servers.length, "Global MCP Server", "Global MCP Servers")}: ${names(servers)}`,
      drift.length > 0 && `drift: ${names(drift)}`,
    ].filter(Boolean);
    return { title: `${total} new Inbox findings`, body: `${parts.join("; ")}. ${review}` };
  }
  if (skills.length > 0)
    return {
      title: skills.length === 1 ? "New Global Skill found" : `${skills.length} new Global Skills found`,
      body: `${names(skills)}. ${review}`,
    };
  if (servers.length > 0)
    return {
      title: servers.length === 1 ? "New Global MCP Server found" : `${servers.length} new Global MCP Servers found`,
      body: `${names(servers)}. ${review}`,
    };
  return {
    title: drift.length === 1 ? "Drift found" : `${drift.length} drift findings`,
    body: `${names(drift)}. ${review}`,
  };
};

/**
 * The daily run's Scan: read-only like every Scan (it never Adopts), and it
 * notifies about Global Skills, Global MCP Servers and drift it hasn't told you
 * about yet and that aren't ignored. What it has told you about is owned state
 * in `settings.json` (ADR-0005), so it doesn't matter which Scan found a
 * finding first (a watcher re-scan, the startup Scan) or whether the cache was
 * rebuilt. The first run only records what's there, as the baseline.
 */
export const scanJob = ({ scans, settings, drift }: ScanJobOptions): DailyJob => ({
  name: "scan",
  run: async ({ client, notifier }) => {
    // A Scan of its own, after any running one, so the Activity Log records it for this client.
    await scans.settle();
    const baseline = settings.value.notifiedFindings ?? scans.latest?.globalSkills.map((skill) => skill.id) ?? [];
    const result = await scans.run(client);
    const skills: Found[] = result.globalSkills.map((skill) => ({ id: skill.id, label: skill.name }));
    const servers: Found[] = result.globalMcpServers.map((server) => ({ id: server.id, label: server.name }));
    const drifted: Found[] = (await drift()).flatMap((group) =>
      group.findings.map((finding) => ({ id: finding.id, label: `${group.name} › ${finding.name ?? "the Project"}` })),
    );
    const first = settings.value.notifiedFindings === undefined;
    const known = new Set([...baseline, ...settings.value.ignoredFindings]);
    // The first run's baseline is the previous Scan's Global Skills; anything else there was already in the Inbox.
    const fresh = (found: Found[], all: boolean) => found.filter((item) => !known.has(item.id) && (all || !first));
    const news = [fresh(skills, true), fresh(servers, false), fresh(drifted, false)] as const;
    // Remember everything present now; a finding that went away is forgotten, so it's news if it comes back.
    const present = [...new Set([...skills, ...servers, ...drifted].map((item) => item.id))].sort();
    if (first || present.join("\n") !== (settings.value.notifiedFindings ?? []).join("\n"))
      await settings.update((current) => ({ ...current, notifiedFindings: present }));
    if (news.every((found) => found.length === 0)) return;
    notifier.notify({ ...message(...news), path: "/inbox" });
  },
});
