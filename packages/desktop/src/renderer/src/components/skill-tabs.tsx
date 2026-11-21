import type { SkillDetail } from "@dark-matter/contracts";
import type { ComponentType } from "react";
import { SkillPreview } from "./skill-preview";
import { SkillProjects } from "./skill-projects";
import { SkillProvenance } from "./skill-provenance";

/** One tab of the Skill page; `id` is its `?tab=` value. */
export interface SkillTab {
  id: string;
  label: string;
  Panel: ComponentType<{ skill: SkillDetail }>;
}

/**
 * The Skill page's tabs in IA order (#15): Preview, Files, Projects, Provenance.
 * Files (editor) and Projects (#27) slot in between as their tickets land.
 */
export const skillTabs: SkillTab[] = [
  { id: "preview", label: "Preview", Panel: SkillPreview },
  { id: "projects", label: "Projects", Panel: SkillProjects },
  { id: "provenance", label: "Provenance", Panel: SkillProvenance },
];
