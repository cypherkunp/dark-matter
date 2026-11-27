import type { SkillDetail } from "@dark-matter/contracts";
import type { ComponentType } from "react";
import { SkillExplorer } from "./skill-explorer";
import { SkillFiles } from "./skill-files";
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
 * The Skill page's tabs in IA order (#15): Preview, Explorer, Files, Projects, Provenance.
 * Explorer reads the whole Skill folder; the Library's Skill rows open straight into it.
 */
export const skillTabs: SkillTab[] = [
  { id: "preview", label: "Preview", Panel: SkillPreview },
  { id: "explorer", label: "Explorer", Panel: SkillExplorer },
  { id: "files", label: "Files", Panel: SkillFiles },
  { id: "projects", label: "Projects", Panel: SkillProjects },
  { id: "provenance", label: "Provenance", Panel: SkillProvenance },
];
