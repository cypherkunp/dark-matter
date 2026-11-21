import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import {
  type ActivityClient,
  type SavedSkillFile,
  type SaveSkillFileInput,
  type SkillFileContent,
  type SkillFilePath,
  SkillFileNotFound,
  type SkillFiles,
  SkillNotFound,
} from "@dark-matter/contracts";
import type { ActivityLog } from "./activity";
import { writeFileAtomic } from "./atomic";
import { type Library, splitKey } from "./library";
import { readSkillFiles } from "./skill-hash";
import { frontmatterWarnings, splitSkillMd } from "./skill-page";

/** Text has no NUL byte; anything else opens read-only as binary. */
const isBinary = (content: Buffer) => content.includes(0);

/** Never listed: git internals and Python caches. */
const hidden = (path: string) => path.startsWith(".git/") || path.split("/").includes("__pycache__");

export interface SkillEditorOptions {
  library: Library;
  activity: ActivityLog;
  onChange: () => void;
}

/**
 * The Skill page's Files tab (#34): a Library Skill's files, read and saved in
 * place. A save writes exactly the text it's given, atomically, through the
 * Library folder, so every Link sees it at once and a Local Source is edited
 * where it's authored.
 */
export class SkillEditor {
  constructor(private readonly options: SkillEditorOptions) {}

  private folder(key: string): string {
    if (!this.options.library.lock.value.skills[key]) throw new SkillNotFound(key);
    return this.options.library.folder(key);
  }

  /** The real path of a file inside the Skill folder, or SkillFileNotFound. */
  private async resolve({ key, path }: SkillFilePath): Promise<string> {
    const folder = this.folder(key);
    const notFound = new SkillFileNotFound(key, path);
    if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) throw notFound;
    const root = await realpath(folder).catch(() => {
      throw notFound;
    });
    const real = await realpath(join(folder, path)).catch(() => null);
    if (!real?.startsWith(root + sep) || !(await stat(real)).isFile()) throw notFound;
    return real;
  }

  async files(key: string): Promise<SkillFiles> {
    const files = await readSkillFiles(this.folder(key), { all: true }).catch(() => []);
    return {
      files: files
        .filter((file) => !hidden(file.path))
        .map((file) => ({ path: file.path, size: file.content.length, binary: isBinary(file.content) })),
    };
  }

  async readFile(input: SkillFilePath): Promise<SkillFileContent> {
    const content = await readFile(await this.resolve(input));
    const binary = isBinary(content);
    return { path: input.path, content: binary ? null : content.toString("utf8"), binary };
  }

  saveFile({ key, path, content }: SaveSkillFileInput, client: ActivityClient): Promise<SavedSkillFile> {
    return this.options.activity.track(
      { client, action: "skill.saveFile", subjects: [{ kind: "skill", id: key }] },
      async (wrote) => {
        const real = await this.resolve({ key, path });
        await writeFileAtomic(real, content, (await stat(real)).mode & 0o777);
        wrote(real);
        this.options.onChange();
        const warnings =
          path === "SKILL.md" ? frontmatterWarnings(splitSkillMd(content).frontmatter, splitKey(key).name) : [];
        return { warnings, modified: await this.options.library.modified(key) };
      },
    );
  }
}
