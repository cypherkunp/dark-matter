import { Activity, Bot, Download, Inbox, Layers, Library, type LucideIcon, Search, Server, Star } from "lucide-react";

/** One row of the sidebar tree. `path` is the route it opens. */
export interface NavItem {
  label: string;
  path: string;
  icon: LucideIcon;
}

/** A sidebar section, in the order of the information architecture (#15). */
export interface NavSection {
  /** Uppercase section header; `null` for the rows above the first header. */
  title: string | null;
  items: NavItem[];
  /** A collapsed group at the bottom of the section, e.g. Namespaces or Suggested. */
  group?: { label: string; path: string };
}

export const navSections: NavSection[] = [
  { title: null, items: [{ label: "Inbox", path: "/inbox", icon: Inbox }] },
  {
    title: "Library",
    items: [
      { label: "All Skills", path: "/library", icon: Library },
      { label: "Favourites", path: "/library/favourites", icon: Star },
      { label: "Collections", path: "/library/collections", icon: Layers },
    ],
    // Then one row per Namespace (the sidebar adds them from the Library).
  },
  {
    title: "Projects",
    items: [],
    group: { label: "Suggested", path: "/projects/suggested" },
  },
  {
    title: "Get Skills",
    items: [
      { label: "skills.sh", path: "/get/skills-sh", icon: Search },
      { label: "GitHub import", path: "/get/github", icon: Download },
    ],
  },
  {
    title: "Computer",
    items: [
      { label: "Agents", path: "/computer/agents", icon: Bot },
      { label: "MCP Servers", path: "/computer/mcp-servers", icon: Server },
      { label: "Activity", path: "/computer/activity", icon: Activity },
    ],
  },
];

const searchText = (search: Record<string, unknown>, key: string) =>
  typeof search[key] === "string" ? search[key] : "";

/** The breadcrumb for a path (and its search params): its section, then its own label. */
export const breadcrumbFor = (path: string, search: Record<string, unknown> = {}): string[] => {
  if (path === "/settings") return ["Settings"];
  if (path === "/namespace") return ["Library", searchText(search, "name")];
  if (path === "/skill") {
    const key = searchText(search, "key");
    const at = key.lastIndexOf("/");
    return ["Library", key.slice(0, at), key.slice(at + 1)];
  }
  if (path === "/project") return ["Projects"];
  for (const section of navSections) {
    const entries = [...section.items, ...(section.group ? [section.group] : [])];
    const match = entries.find((entry) => entry.path === path);
    if (match) return section.title ? [section.title, match.label] : [match.label];
  }
  return ["Dark Matter"];
};
