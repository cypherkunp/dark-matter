import type { ActivityEntry } from "@dark-matter/contracts";

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
  "managedSkills.turnOff": "Turned off an Agent-managed Skill",
  "adopt.apply": "Adopted Skills",
  "adopt.undo": "Undid an Adopt",
  "namespace.rename": "Renamed a Namespace",
};

export const actionLabel = (action: string) => actionLabels[action] ?? action;

const clientLabels: Record<ActivityEntry["client"], string> = {
  app: "app",
  cli: "CLI",
  mcp: "Agent over MCP",
  "scheduled-scan": "Scheduled Scan",
};

export const clientLabel = (client: ActivityEntry["client"]) => clientLabels[client];

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
