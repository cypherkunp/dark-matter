import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTRPC } from "@/lib/trpc";
import { useScan } from "./use-scan";

/** One ⌘K entry: an action to run or a place to jump to. */
export interface Command {
  /** Unique across all groups, e.g. `skill:<key>`. */
  id: string;
  group: string;
  label: string;
  /** Muted text on the right, also searched. */
  hint?: string;
  run(): void;
}

/** Actions first. skills.sh search and Import a URL join here with their tickets. */
const useActionCommands = (): Command[] => {
  const { scan, scanning } = useScan();
  const navigate = useNavigate();
  return [
    { id: "action:scan", group: "Actions", label: scanning ? "Scanning…" : "Scan now", run: scan },
    { id: "action:inbox", group: "Actions", label: "Open Inbox", run: () => void navigate({ to: "/inbox" }) },
    {
      id: "action:import-github",
      group: "Actions",
      label: "Import from GitHub…",
      hint: "owner/repo or URL",
      run: () => void navigate({ to: "/get/github" }),
    },
  ];
};

const useSkillCommands = (): Command[] => {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const skills = useQuery(trpc.library.list.queryOptions()).data?.skills ?? [];
  return skills.map((skill) => ({
    id: `skill:${skill.key}`,
    group: "Skills",
    label: skill.name,
    hint: skill.namespace,
    run: () => void navigate({ to: "/skill", search: { key: skill.key } }),
  }));
};

const useNamespaceCommands = (): Command[] => {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const skills = useQuery(trpc.library.list.queryOptions()).data?.skills ?? [];
  return [...new Set(skills.map((skill) => skill.namespace))].sort().map((namespace) => ({
    id: `namespace:${namespace}`,
    group: "Namespaces",
    label: namespace,
    run: () => void navigate({ to: "/namespace", search: { name: namespace } }),
  }));
};

const useProjectCommands = (): Command[] => {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const projects = useQuery(trpc.project.list.queryOptions()).data ?? [];
  return projects.map((project) => ({
    id: `project:${project.path}`,
    group: "Projects",
    label: project.name,
    hint: project.path,
    run: () => void navigate({ to: "/project", search: { path: project.path } }),
  }));
};

/** ⌘K starts a skills.sh search for what's typed (#31). */
const useSkillsShCommands = (query: string): Command[] => {
  const navigate = useNavigate();
  const text = query.trim();
  return [
    {
      id: "action:skills-sh",
      group: "skills.sh",
      label: text.length >= 2 ? `Search skills.sh for “${text}”` : "Search skills.sh…",
      hint: "skills.sh",
      run: () => void navigate({ to: "/get/skills-sh", search: text.length >= 2 ? { q: text } : {} }),
    },
  ];
};

/**
 * The ⌘K registry: every command source, in the order its group is listed.
 * A ticket adds commands by writing a `use…Commands` hook and one line here.
 */
export const useCommands = (query = ""): Command[] => [
  ...useActionCommands(),
  ...useSkillCommands(),
  ...useNamespaceCommands(),
  ...useProjectCommands(),
  // Last, so Enter still opens a local match first.
  ...useSkillsShCommands(query),
];

/** Commands matching every word of `query` (in label, group or hint), in registry order. */
export const filterCommands = (commands: Command[], query: string): Command[] => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return commands.filter((command) => {
    const text = `${command.label} ${command.group} ${command.hint ?? ""}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
};
