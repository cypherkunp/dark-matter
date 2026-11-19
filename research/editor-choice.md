# Which embedded markdown and code editor to use

Resolves [#6](https://github.com/cypherkunp/dark-matter/issues/6). Researched 2026-11-19.

## Answer

**Use CodeMirror 6 for everything**: every file in a Skill folder (`SKILL.md`, `.py`, `.sh`, `.ts`, `.json`, `.md`). Pair it with a **read-only rendered preview** built with `react-markdown` + `remark-gfm` + `remark-frontmatter`. Show it side by side or as a toggle.

The markdown editor stays a source editor. Light "live preview" styling (bold looks bold, heading markers dimmed, frontmatter highlighted as YAML) comes from CodeMirror decorations. The text on disk is only ever changed by what the user types.

Do **not** use a WYSIWYG markdown editor (Milkdown, MDXEditor, Tiptap, BlockNote) as the editing surface. Do **not** use Monaco.

## Why

1. **Lossless round-trip is the deciding criterion, and only a source editor has it.** Every WYSIWYG editor parses markdown into a tree and prints it back out. That rewrites the user's formatting even when they changed nothing (see the test below). Dark Matter edits files that Agents read and that users keep in git. A silent rewrite of a Skill the user only opened is a bug that shows up in their diffs.
2. **One engine for code and markdown.** It is one dependency, one theme and one set of keybindings. It is also the smallest real option: about 240 KB gzipped with all six languages, against about 1.2 MB for Monaco alone.
3. **Electron and CSP friendly with no setup.** It needs no web workers, no `eval` and no CDN. It has a `EditorView.cspNonce` facet for its injected styles, so a strict CSP (`script-src 'self'`) works without changes.
4. **It themes straight from shadcn tokens.** `EditorView.theme()` takes plain CSS, so `var(--background)`, `var(--foreground)`, `var(--muted)`, `var(--ring)` and the rest work directly. Light and dark mode then follow the `.dark` class with no JS re-theme.
5. **First-class YAML frontmatter.** `@codemirror/lang-yaml` exports `yamlFrontmatter({ content: markdown() })`. It parses the `---` block as YAML and the body as markdown in one document, with correct highlighting and folding.

## Lossless round-trip test

A sample `SKILL.md` was round-tripped with no edits. It had frontmatter, `*` bullets, `__strong__`, `1)` lists, a setext heading, a GFM table, a backslash hard break, inline HTML and a reference link. Scripts and output are in the session scratchpad and were not committed.

| Pipeline | Used by | What changed with zero user edits |
| --- | --- | --- |
| CodeMirror 6 | (recommended) | Nothing. The document is the text. |
| `remark-parse` → `remark-stringify` (+gfm, +frontmatter) | Milkdown (remark serializer), MDXEditor (`mdast-util-to-markdown`) | `__x__`→`**x**`, `1)`→`1.`, setext→`##`, table re-padded and delimiter row rewritten, blank lines inserted. Frontmatter survived. |
| Tiptap 3.34 `@tiptap/markdown` + StarterKit | Tiptap | **Frontmatter destroyed** (turned into `## name: …` plus a stray rule). `*` in YAML escaped to `\*`. Table **deleted**. `<kbd>` HTML stripped. Reference link inlined and definition dropped. Hard break rewritten. Bullets→`-`. |
| BlockNote 0.57 | BlockNote | Not run. Its only markdown export API is named `blocksToMarkdownLossy`, which says it all. |

Milkdown and MDXEditor are the "good" WYSIWYG cases, and they still rewrite style choices on every save. Tiptap and BlockNote lose content.

## Comparison

Bundle sizes were measured with esbuild (`--bundle --minify`, React external) on the versions listed. The gzip column is the one that matters for an Electron renderer.

### Code editor

| | CodeMirror 6 | Monaco |
| --- | --- | --- |
| Version / latest release | `@codemirror/view` 6.43.15 (Oct 2026) | `monaco-editor` 0.57.0 (Nov 2026) |
| Bundle (min / gz) | 686 KB / 239 KB **with** md, yaml, py, js/ts, json, shell | 4.6 MB / 1.2 MB + 175 KB CSS, **plus** separate language workers |
| Web workers | None | Required for TS/JSON/CSS/HTML language services. You must wire `MonacoEnvironment.getWorker` and allow `worker-src` in the CSP. |
| Electron gotchas | None | `@monaco-editor/react` loads Monaco from jsDelivr by default. You must call `loader.config({ monaco })` or it breaks offline and under CSP. Trusted Types and dynamic style injection need CSP allowances. |
| Frontmatter | `yamlFrontmatter()` built in | No built-in. Needs a custom Monarch tokenizer. |
| Theming with shadcn vars | Native CSS, so `var(--…)` works directly | `defineTheme` takes hex colors only. You must read computed styles, convert shadcn's `oklch()` values to hex, and re-call `setTheme` when the mode changes. |
| Maintenance | One maintainer (Marijn Haverbeke), very active, 12 open issues | Microsoft, active, 892 open issues. It is a by-product of VS Code. |
| What you'd miss | TS IntelliSense, which we don't need for viewing and editing Skill scripts | n/a |

### Markdown editor

| | CodeMirror 6 + react-markdown preview | Milkdown (Crepe) | MDXEditor | Tiptap | BlockNote |
| --- | --- | --- | --- | --- | --- |
| Version / latest release | see above; `react-markdown` 10.1.0 | 7.23.0 (Oct 2026) | 4.5.0 (Nov 2026) | 3.34.0 (Nov 2026) | 0.57.0 (Oct 2026) |
| Bundle (min / gz) | +177 KB / 55 KB for the preview (editor shared with code) | 2.8 MB / 936 KB | 2.6 MB / 885 KB | 480 KB / 153 KB (StarterKit + markdown; tables etc. extra) | 6.1 MB / 1.4 MB |
| Lossless round-trip | **Yes** | No (normalizes) | No (normalizes) | **No, loses content** | **No, lossy by design** |
| YAML frontmatter | Yes (`yamlFrontmatter`; `remark-frontmatter` in preview) | No official plugin | Yes (`frontmatterPlugin`) | No | No |
| Electron / CSP | Clean | Clean (ProseMirror) | Clean (Lexical) | Clean (ProseMirror) | Clean, but heavy |
| shadcn theming | CSS vars | CSS vars on its own theme classes | CSS vars, but its own toolbar UI fights shadcn | Headless, so easy | Ships its own Mantine/shadcn UI packages |
| Maintenance | Excellent | Active, 12k stars, 54 open issues | Active, 1 core maintainer, 82 open issues | Very active, company-backed, 945 open issues | Active. Core is MPL-2.0; some `xl-*` packages are GPL/commercial. |

## Implementation notes for the build tickets

- Packages: `@codemirror/view`, `@codemirror/state`, `@codemirror/commands`, `@codemirror/language`, `@codemirror/search`, `@codemirror/autocomplete`, `@codemirror/lang-markdown`, `@codemirror/lang-yaml`, `@codemirror/lang-python`, `@codemirror/lang-javascript` (covers TS), `@codemirror/lang-json`, `@codemirror/legacy-modes` (shell via `StreamLanguage.define(shell)`). Pick the language by file extension.
- React wrapper: a thin in-house `useCodeMirror` hook (about 60 lines: create the `EditorView` on mount, use `Compartment`s for language, theme and readOnly). `@uiw/react-codemirror` (4.25.12) also works, but it has 172 open issues and adds little.
- Theme: one `EditorView.theme({...})` using `var(--background)`, `var(--foreground)`, `var(--muted-foreground)`, `var(--accent)`, `var(--border)`, `var(--ring)`, plus a `HighlightStyle` mapped to the `--chart-*` tokens or a small set of syntax variables added to the shadcn theme. Do not switch themes in JS. CSS variables already change under `.dark`.
- Preview: `react-markdown` + `remark-gfm` + `remark-frontmatter`. Parse the frontmatter separately with `yaml` and render it as a shadcn property table (name, description, allowed-tools) above the body. Map elements to shadcn typography classes through `components`. Render without `rehype-raw` (no raw HTML) so a Skill can never inject markup into the app.
- Optional "live preview" polish in the source editor: a `ViewPlugin` that adds decorations to dim `#`, `**` and backticks and style headings. It is display-only and never edits text.
- CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-…'`, with the nonce passed through `EditorView.cspNonce`. No `worker-src` is needed.

## What to avoid

- **Monaco**: about 5x the size, workers and a CDN-by-default loader to fight in Electron, and hex-only theming that cannot follow shadcn variables. Its one advantage, TS IntelliSense, is not needed for Skill scripts.
- **Any WYSIWYG editor as the default edit surface**: it rewrites `SKILL.md` formatting on save. Tiptap and BlockNote also lose frontmatter, tables, HTML and reference links. BlockNote is also the largest bundle and pulls in a Notion-style block model that doesn't fit plain markdown files.
- If a rich-text mode is ever requested, make it opt-in, use **MDXEditor** (the only one with a frontmatter plugin), and show a diff of the resulting rewrite before saving. Do not build on Milkdown (no frontmatter support), Tiptap or BlockNote.

## Sources

- npm registry metadata (versions, publish dates) and GitHub repo stats via `gh api`, 2026-11-19.
- Bundle measurements: esbuild 0.28.2, minified ESM, React external.
- CodeMirror: `@codemirror/lang-yaml` typings (`yamlFrontmatter`), `@codemirror/view` (`EditorView.cspNonce`), https://codemirror.net/docs/
- Monaco: https://github.com/microsoft/monaco-editor (worker setup via `MonacoEnvironment`), `@monaco-editor/react` loader docs (default jsDelivr CDN, `loader.config({ monaco })`).
- MDXEditor `frontmatterPlugin`: https://mdxeditor.dev/editor/docs/front-matter
- BlockNote markdown export (`blocksToMarkdownLossy`): https://www.blocknotejs.org/docs/editor-api/converting-blocks
- Tiptap markdown: https://tiptap.dev/docs/editor/markdown
