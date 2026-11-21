import type { ActivityClient, ActivityEntry, ActivityFilter, ActivitySubject } from "@dark-matter/contracts";

/** Human labels for Activity Log actions; unknown actions show as recorded. */
const actionLabels: Record<string, string> = {
  "settings.updatePreferences": "Saved preferences",
  "ownedFiles.discard": "Discarded a hand edit",
  "scan.run": "Scanned",
  "inbox.ignore": "Ignored a finding",
  "project.add": "Added a Project",
  "project.dismiss": "Dismissed a Suggested Project",
  "project.setAgents": "Chose a Project's Agents",
  "project.locate": "Located a moved Project",
  "project.remove": "Removed a Project",
  "project.addSkills": "Added Project Skills",
  "project.skillOn": "Turned a Project Skill On",
  "project.skillOff": "Turned a Project Skill Off",
  "project.removeSkill": "Removed a Project Skill",
  "project.resolveConflict": "Resolved a Name Conflict",
  "project.updateCopy": "Updated a Copy from the Library",
  "project.pullCopy": "Pulled a Copy's edits into the Library",
  "project.fulfilLock": "Fulfilled skills-lock.json entries",
  "managedSkills.turnOff": "Turned off an Agent-managed Skill",
  "adopt.apply": "Adopted Skills",
  "adopt.undo": "Undid an Adopt",
  "mcp.adopt": "Adopted MCP Servers",
  "mcp.undoAdopt": "Undid an MCP Server Adopt",
  "mcp.setSecret": "Entered a Secret",
  "mcp.updateDefinition": "Edited an MCP Server",
  "project.addMcpServers": "Added Project MCP Servers",
  "project.mcpServerOn": "Turned a Project MCP Server On",
  "project.mcpServerOff": "Turned a Project MCP Server Off",
  "project.removeMcpServer": "Removed a Project MCP Server",
  "namespace.rename": "Renamed a Namespace",
  "skill.saveFile": "Saved a Skill file",
  "skill.delete": "Moved a Skill to the trash",
  "trash.purge": "Emptied expired trash",
  "collections.create": "Created a Collection",
  "collections.rename": "Renamed a Collection",
  "collections.setItems": "Edited a Collection",
  "collections.delete": "Deleted a Collection",
  "collections.apply": "Added a Collection to Projects",
  "importer.import": "Imported Skills from GitHub",
  "importer.setToken": "Saved the GitHub token",
  "importer.removeToken": "Removed the GitHub token",
  "importer.checkUpdates": "Checked for updates",
  "importer.applyUpdate": "Updated a Skill from its Source",
  "importer.keepMine": "Kept my version of a Skill",
  "importer.detach": "Detached a Skill from its Source",
  "importer.repoint": "Re-pointed a Skill",
};

export const actionLabel = (action: string) => actionLabels[action] ?? action;

/** The actions the Activity screen's action filter offers. */
export const knownActions = Object.keys(actionLabels);

const clientLabels: Record<ActivityEntry["client"], string> = {
  app: "app",
  cli: "CLI",
  mcp: "Agent over MCP",
  "scheduled-scan": "Scheduled Scan",
};

export const clientLabel = (client: ActivityEntry["client"]) => clientLabels[client];

export const activityClients = Object.keys(clientLabels) as ActivityClient[];

const localDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** Groups entries (newest first) by local calendar day, keeping their order. */
export const groupByDay = (entries: ActivityEntry[], now: Date) => {
  const today = localDay(now);
  const yesterday = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const days: { key: string; label: string; entries: ActivityEntry[] }[] = [];
  for (const entry of entries) {
    const time = new Date(entry.time);
    const key = localDay(time);
    let day = days.at(-1);
    if (day?.key !== key) {
      const label =
        key === today
          ? "Today"
          : key === yesterday
            ? "Yesterday"
            : time.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
      day = { key, label, entries: [] };
      days.push(day);
    }
    day.entries.push(entry);
  }
  return days;
};

/**
 * The Activity screen's filters as they sit in the URL, so other pages can
 * link to a filtered view. Dates are local calendar days, `YYYY-MM-DD`.
 */
export interface ActivitySearch {
  action?: string;
  client?: ActivityClient;
  skill?: string;
  project?: string;
  failures?: boolean;
  from?: string;
  to?: string;
  q?: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);
const day = (value: unknown) => (typeof value === "string" && DAY.test(value) ? value : undefined);

export const parseActivitySearch = (search: Record<string, unknown>): ActivitySearch => {
  const client = activityClients.find((known) => known === search.client);
  const parsed: { [K in keyof ActivitySearch]: ActivitySearch[K] | undefined } = {
    action: text(search.action),
    client,
    skill: text(search.skill),
    project: text(search.project),
    failures: search.failures === true || search.failures === "true" ? true : undefined,
    from: day(search.from),
    to: day(search.to),
    q: text(search.q),
  };
  return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined)) as ActivitySearch;
};

/** Local midnight at the start of a `YYYY-MM-DD` day, plus `days`. */
const localMidnight = (value: string, days = 0) => {
  const [year = 0, month = 1, date = 1] = value.split("-").map(Number);
  return new Date(year, month - 1, date + days).toISOString();
};

/** The core's filter for a URL filter: `to` takes in the whole of its day. */
export const toActivityFilter = (search: ActivitySearch): ActivityFilter => {
  const filter: ActivityFilter = {};
  if (search.action) filter.actions = [search.action];
  if (search.client) filter.clients = [search.client];
  if (search.skill) filter.skill = search.skill;
  if (search.project) filter.project = search.project;
  if (search.failures) filter.failuresOnly = true;
  if (search.from) filter.from = localMidnight(search.from);
  if (search.to) filter.to = localMidnight(search.to, 1);
  if (search.q?.trim()) filter.search = search.q.trim();
  return filter;
};

/** Where an entry's subject has a page, as a router link. */
export const subjectLink = (subject: ActivitySubject) => {
  switch (subject.kind) {
    case "skill":
      return { to: "/skill", search: { key: subject.id } } as const;
    case "project":
      return { to: "/project", search: { path: subject.id } } as const;
    case "finding":
      return { to: "/inbox" } as const;
    case "settings":
      return { to: "/settings" } as const;
    case "collection":
      return { to: "/collection", search: { name: subject.id } } as const;
    default:
      return null;
  }
};

/** Saves the JSON export of a filtered view through the browser's download, which Electron turns into a Save dialog. */
export const saveJson = (value: unknown, name: string) => {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
};
