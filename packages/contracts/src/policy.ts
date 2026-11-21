import { z } from "zod";
import { ImportSkillsInput } from "./importer";
import {
  AddProjectMcpServers,
  AddProjectSkills,
  ProjectSkillChange,
  RemoveProjectMcpServer,
  SetProjectMcpServerOn,
} from "./schemas";
import { SkillsShGetInput } from "./skills-sh";

/**
 * What a requestable change is, for the Grant (ADR-0006): a Grant covers
 * On/Off and adding or removing a Link; the core looks at the current state
 * (a Copy, a Shared MCP Server) before it lets one through.
 */
export type RequestCategory =
  | "skill.add"
  | "skill.remove"
  | "skill.onOff"
  | "mcpServer.add"
  | "mcpServer.remove"
  | "mcpServer.onOff"
  | "import";

/**
 * How the core treats a mutation from a client other than the app.
 * - `read`: free, like every query (a Scan only reads).
 * - `requestable`: becomes a Request you approve or deny, unless a Grant covers it.
 * - `appOnly`: refused (`AppOnly`); it moves, deletes or rewrites owned content, or touches Secrets or settings.
 * The app's own calls always pass straight through.
 */
export type OperationPolicy =
  | { kind: "read" }
  | { kind: "appOnly" }
  | { kind: "requestable"; category: RequestCategory; input: z.ZodType };

const read = { kind: "read" } as const;
const appOnly = { kind: "appOnly" } as const;
const requestable = (category: RequestCategory, input: z.ZodType) =>
  ({ kind: "requestable", category, input }) as const;

/**
 * The policy for every mutation the router serves, by procedure path. A test
 * enumerates the router, so a new mutation can't ship unclassified; one missing
 * here is treated as app-only anyway.
 */
export const operationPolicy = {
  "scan.run": read,

  "project.addSkills": requestable("skill.add", AddProjectSkills),
  "project.removeSkill": requestable("skill.remove", ProjectSkillChange),
  "project.setSkillOn": requestable("skill.onOff", ProjectSkillChange.extend({ on: z.boolean() })),
  "project.addMcpServers": requestable("mcpServer.add", AddProjectMcpServers),
  "project.removeMcpServer": requestable("mcpServer.remove", RemoveProjectMcpServer),
  "project.setMcpServerOn": requestable("mcpServer.onOff", SetProjectMcpServerOn),
  "importer.import": requestable("import", ImportSkillsInput),
  "skillsSh.get": requestable("import", SkillsShGetInput),

  "settings.updatePreferences": appOnly,
  "ownedFiles.discard": appOnly,
  "inbox.ignore": appOnly,
  "drift.restore": appOnly,
  "drift.accept": appOnly,
  "managedSkills.turnOff": appOnly,
  "managedMcp.turnOff": appOnly,
  "adopt.execute": appOnly,
  "adopt.undo": appOnly,
  "mcp.adoptExecute": appOnly,
  "mcp.undoAdopt": appOnly,
  "mcp.setSecret": appOnly,
  "mcp.updateDefinition": appOnly,
  "mcp.deleteSecret": appOnly,
  "project.add": appOnly,
  "project.dismiss": appOnly,
  "project.setAgents": appOnly,
  "project.locate": appOnly,
  "project.remove": appOnly,
  "project.updateCopy": appOnly,
  "project.pullCopy": appOnly,
  "project.fulfilLock": appOnly,
  "project.resolveConflict": appOnly,
  "project.setMcpServerMode": appOnly,
  "project.updateMcpServer": appOnly,
  "project.pullMcpServer": appOnly,
  "project.trustInCodex": appOnly,
  "project.setGrant": appOnly,
  "skill.saveFile": appOnly,
  "skill.delete": appOnly,
  "trash.restore": appOnly,
  "namespace.rename": appOnly,
  "collections.create": appOnly,
  "collections.rename": appOnly,
  "collections.setItems": appOnly,
  "collections.delete": appOnly,
  "collections.execute": appOnly,
  "importer.setToken": appOnly,
  // Update checks spend the GitHub rate limit; applying, Keep mine, Detach and re-pointing are Modified choices.
  "importer.checkUpdates": appOnly,
  "importer.applyUpdates": appOnly,
  "importer.detach": appOnly,
  "importer.repoint": appOnly,
  "inbox.unignore": appOnly,
  "settings.completeFirstRun": appOnly,
  // Favourites are the app owner's own view (ADR-0006).
  "favourites.setSkill": appOnly,
  "favourites.setSource": appOnly,
  "requests.approve": appOnly,
  "requests.deny": appOnly,
} satisfies Record<string, OperationPolicy>;

/** A mutation's policy; an unclassified one is app-only (fail closed). */
export const policyFor = (path: string): OperationPolicy =>
  (operationPolicy as Record<string, OperationPolicy>)[path] ?? appOnly;
