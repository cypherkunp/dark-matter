import type { Scans } from "./scans";
import type { DailyJob } from "./scheduler";

/**
 * The daily run's Scan: read-only like every Scan (it never Adopts), and it
 * notifies about Global Skills that weren't in the previous Scan and aren't
 * ignored.
 */
export const scanJob = (scans: Scans, ignored: () => readonly string[]): DailyJob => ({
  name: "scan",
  run: async ({ client, notifier }) => {
    // A Scan of its own, after any running one, so the Activity Log records it for this client.
    await scans.settle();
    const before = new Set(scans.latest?.globalSkills.map((skill) => skill.id));
    const result = await scans.run(client);
    const skip = new Set(ignored());
    const found = result.globalSkills.filter((skill) => !before.has(skill.id) && !skip.has(skill.id));
    if (found.length === 0) return;
    notifier.notify({
      title: found.length === 1 ? "New Global Skill found" : `${found.length} new Global Skills found`,
      body: `${found.map((skill) => skill.name).join(", ")}. Review ${found.length === 1 ? "it" : "them"} in the Inbox.`,
      path: "/inbox",
    });
  },
});
