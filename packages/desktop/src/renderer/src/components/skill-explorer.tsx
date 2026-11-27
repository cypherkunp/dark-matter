import type { SkillDetail, SkillFileEntry } from "@dark-matter/contracts";
import { File } from "@pierre/diffs/react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { useQuery } from "@tanstack/react-query";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { CODE_THEMES, PREFERRED_HIGHLIGHTER, useColorScheme } from "@/lib/syntax-highlighting";
import { useTRPC } from "@/lib/trpc";

const ENTRY_FILE = "SKILL.md";

/** The app's tokens inside the tree's shadow root, so it reads as part of the sidebar. */
const TREE_STYLE = {
  "--trees-bg-override": "transparent",
  "--trees-fg-override": "var(--foreground)",
  "--trees-fg-muted-override": "var(--muted-foreground)",
  "--trees-selected-bg-override": "color-mix(in oklch, var(--foreground) 10%, transparent)",
  "--trees-border-color-override": "var(--border)",
  "--trees-search-bg-override": "var(--background)",
  "--trees-font-family-override": "var(--font-sans)",
  "--trees-font-size-override": "12px",
} as CSSProperties;

const CODE_STYLE = {
  "--diffs-font-family": "var(--font-mono)",
  "--diffs-font-size": "12.5px",
  "--diffs-line-height": "1.6",
} as CSSProperties;

const formatSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** The Skill folder as a Pierre file tree; picking a file reports its path. */
function ExplorerTree({
  files,
  selected,
  onSelect,
}: {
  files: SkillFileEntry[];
  selected: string;
  onSelect: (path: string) => void;
}) {
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const fileSet = useRef(new Set<string>());
  fileSet.current = new Set(files.map((file) => file.path));
  const paths = files.map((file) => file.path);

  const { model } = useFileTree({
    paths,
    initialExpansion: "open",
    initialSelectedPaths: [selected],
    flattenEmptyDirectories: true,
    search: true,
    density: "compact",
    icons: { set: "complete", colored: true },
    onSelectionChange: (selection) => {
      const path = selection.at(-1);
      // Folders select too; only a file opens in the viewer.
      if (path && fileSet.current.has(path)) onSelectRef.current(path);
    },
  });

  // Files added or removed on disk (the core refetches on change) keep the tree current.
  const joined = paths.join("\n");
  const lastJoined = useRef(joined);
  useEffect(() => {
    if (lastJoined.current === joined) return;
    lastJoined.current = joined;
    model.resetPaths(joined === "" ? [] : joined.split("\n"));
  }, [joined, model]);

  return <FileTree model={model} data-testid="explorer-tree" className="block h-full" style={TREE_STYLE} />;
}

/** One file, syntax-highlighted and read-only. */
function ExplorerViewer({ skillKey, entry }: { skillKey: string; entry: SkillFileEntry | undefined }) {
  const trpc = useTRPC();
  const scheme = useColorScheme();
  const path = entry?.path ?? ENTRY_FILE;
  const file = useQuery(trpc.skill.readFile.queryOptions({ key: skillKey, path }));

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <span data-testid="explorer-path" className="truncate font-mono text-meta">
          {path}
        </span>
        {entry && (
          <span className="ml-auto shrink-0 text-muted-foreground text-meta tabular-nums">
            {formatSize(entry.size)}
          </span>
        )}
      </div>
      <div data-testid="explorer-viewer" className="min-h-0 flex-1 overflow-auto">
        {file.error ? (
          <p className="p-4 text-muted-foreground text-body">{file.error.message}</p>
        ) : file.data?.binary || entry?.binary ? (
          <p className="p-4 text-muted-foreground text-body">A binary file can't be shown here.</p>
        ) : file.data?.content != null && file.data.path === path ? (
          <File
            // A new file starts at the top; a theme change re-renders in the other palette.
            key={`${path}:${scheme}`}
            file={{ name: path, contents: file.data.content, cacheKey: `${skillKey}:${path}` }}
            className="min-h-full"
            style={CODE_STYLE}
            options={{
              theme: CODE_THEMES,
              themeType: scheme,
              preferredHighlighter: PREFERRED_HIGHLIGHTER,
              disableFileHeader: true,
              overflow: "wrap",
            }}
          />
        ) : null}
      </div>
    </section>
  );
}

/**
 * The Explorer tab: the whole Skill folder to review before trusting it — every file in
 * a tree, each one highlighted the way T3 Code shows code. Read-only; Files edits.
 */
export function SkillExplorer({ skill }: { skill: SkillDetail }) {
  const trpc = useTRPC();
  const files = useQuery(trpc.skill.files.queryOptions({ key: skill.key }));
  const [selected, setSelected] = useState(ENTRY_FILE);
  const entries = files.data?.files ?? [];

  return (
    <div data-testid="skill-explorer" className="flex h-[calc(100vh-16rem)] min-h-96 overflow-hidden rounded-xl border">
      <nav aria-label="Skill files" className="w-64 shrink-0 border-r bg-muted/30">
        {files.error ? (
          <p className="p-3 text-muted-foreground text-meta">{files.error.message}</p>
        ) : files.data ? (
          <ExplorerTree key={skill.key} files={entries} selected={selected} onSelect={setSelected} />
        ) : null}
      </nav>
      <ExplorerViewer skillKey={skill.key} entry={entries.find((entry) => entry.path === selected)} />
    </div>
  );
}
