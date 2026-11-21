import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { yaml, yamlFrontmatter } from "@codemirror/lang-yaml";
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  type LanguageSupport,
  StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { useEffect, useRef } from "react";

/** The language for a file, by extension (#6): SKILL.md and other Markdown get YAML frontmatter too. */
const languageFor = (path: string): LanguageSupport | Extension => {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (extension) {
    case "md":
    case "mdx":
      return yamlFrontmatter({ content: markdown() });
    case "yaml":
    case "yml":
      return yaml();
    case "json":
      return json();
    case "py":
      return python();
    case "js":
    case "mjs":
    case "cjs":
      return javascript();
    case "ts":
    case "mts":
      return javascript({ typescript: true });
    case "sh":
    case "bash":
    case "zsh":
      return StreamLanguage.define(shell);
    default:
      return [];
  }
};

/** CodeMirror themed with the app's tokens, so it follows light and dark. */
const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "12.5px", backgroundColor: "var(--background)", color: "var(--foreground)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono, ui-monospace, monospace)", lineHeight: "1.6" },
  ".cm-gutters": {
    backgroundColor: "var(--background)",
    color: "var(--muted-foreground)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "color-mix(in oklch, var(--muted) 60%, transparent)" },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "color-mix(in oklch, var(--status-on) 25%, transparent) !important",
  },
});

/**
 * A plain source editor (CodeMirror 6, #6): the text on disk is exactly what's
 * typed, nothing is reformatted. `onSave` runs on ⌘S / Ctrl+S. Uncontrolled:
 * `path` and `initial` are read once, so remount (via `key`) to load another file.
 */
export function CodeEditor({
  path,
  initial,
  onChange,
  onSave,
}: {
  path: string;
  initial: string;
  onChange: (text: string) => void;
  onSave: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  // Latest callbacks without rebuilding the editor (and losing its history).
  const handlers = useRef({ onChange, onSave });
  handlers.current = { onChange, onSave };

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initial,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          foldGutter(),
          history(),
          drawSelection(),
          bracketMatching(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorView.lineWrapping,
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                handlers.current.onSave();
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            indentWithTab,
          ]),
          languageFor(path),
          theme,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) handlers.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    return () => view.destroy();
  }, []);

  return <div ref={host} data-testid="code-editor" className="h-full min-h-0 overflow-hidden" />;
}
