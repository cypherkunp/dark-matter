import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type FrontmatterWarning,
  SkillDescription,
  type SkillDetail,
  SkillName,
  SkillNotFound,
} from "@dark-matter/contracts";
import { parse as parseYaml } from "yaml";
import { type Library, splitKey } from "./library";

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** SKILL.md split at its `---` fences: the raw frontmatter (null without one) and the rest. */
export const splitSkillMd = (text: string): { frontmatter: string | null; body: string } => {
  const match = FENCE.exec(text);
  return match ? { frontmatter: match[1] ?? "", body: text.slice(match[0].length) } : { frontmatter: null, body: text };
};

/**
 * The Agent Skills spec's checks on `name` and `description` (Zod), as
 * warnings: a Skill with problems still loads in some Agents, so nothing blocks.
 */
export const frontmatterWarnings = (frontmatter: string | null, folderName: string): FrontmatterWarning[] => {
  let fields: Record<string, unknown> = {};
  const warnings: FrontmatterWarning[] = [];
  try {
    const parsed: unknown = frontmatter === null ? {} : parseYaml(frontmatter);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fields = parsed as Record<string, unknown>;
    else if (parsed !== null) warnings.push({ field: "frontmatter", message: "frontmatter isn't a YAML mapping" });
  } catch (error) {
    warnings.push({ field: "frontmatter", message: `frontmatter isn't valid YAML: ${(error as Error).message}` });
  }
  const check = (field: "name" | "description", schema: typeof SkillName | typeof SkillDescription) => {
    const value = fields[field];
    if (value === undefined || value === null) return void warnings.push({ field, message: `${field} is missing` });
    if (typeof value !== "string") return void warnings.push({ field, message: `${field} must be text` });
    for (const issue of schema.safeParse(value).error?.issues ?? []) warnings.push({ field, message: issue.message });
  };
  check("name", SkillName);
  if (typeof fields.name === "string" && fields.name !== folderName) {
    warnings.push({ field: "name", message: `name doesn't match the folder name ${folderName}` });
  }
  check("description", SkillDescription);
  return warnings;
};

/** The `skill` domain: what a Skill's page shows. Read-only. */
export const skillServices = (library: Library) => ({
  get: async (key: string): Promise<SkillDetail> => {
    const entry = library.lock.value.skills[key];
    if (!entry) throw new SkillNotFound(key);
    const { namespace, name } = splitKey(key);
    const path = library.folder(key);
    const text = await readFile(join(path, "SKILL.md"), "utf8").catch(() => "");
    const { frontmatter, body } = splitSkillMd(text);
    return { key, namespace, name, path, frontmatter, body, warnings: frontmatterWarnings(frontmatter, name), entry };
  },
});
