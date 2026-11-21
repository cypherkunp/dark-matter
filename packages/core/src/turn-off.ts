import { type ClientKind, UnknownFinding } from "@dark-matter/contracts";
import type { ActivityLog } from "./activity";
import { editConfigFile } from "./config-edit";

/** An Agent-managed finding's off switch: which file it edits, and the edit for one scope. */
export interface FoundOffSwitch {
  file(): string | Promise<string>;
  turnOff(text: string): string;
}

/**
 * "Turn off everywhere" for an Agent-managed Skill or MCP Server (review #22:
 * one path for both): finds it in the latest Scan with that scope offered,
 * edits its Agent's own config file in place, then re-Scans.
 */
export const turnOffManaged = (options: {
  activity: ActivityLog;
  action: "managedSkills.turnOff" | "managedMcp.turnOff";
  id: string;
  client: ClientKind;
  /** The finding's off switch for the scope, or null when it isn't offered. */
  find(): FoundOffSwitch | null;
  rescan(): Promise<unknown>;
}): Promise<void> =>
  options.activity.track(
    { client: options.client, action: options.action, subjects: [{ kind: "finding", id: options.id }] },
    async (wrote) => {
      const off = options.find();
      if (!off) throw new UnknownFinding(options.id);
      const written = await editConfigFile(await off.file(), (text) => off.turnOff(text));
      if (written) wrote(written);
      await options.rescan();
    },
  );
