import { randomBytes } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

/** Writes a file by temp file plus rename, so readers never see half of it. */
export const writeFileAtomic = async (path: string, contents: string, mode = 0o644): Promise<void> => {
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, contents, { mode, flag: "wx" });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
};
