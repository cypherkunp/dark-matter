import { unwatchFile, watchFile } from "node:fs";

/**
 * How often owned files are stat-polled. `fs.watch` (FSEvents) drops edits made
 * soon after a rename on macOS, and polling a handful of small files is cheap.
 */
const POLL_MS = 150;

interface Watched {
  path: string;
  reload(): Promise<boolean>;
}

/**
 * Re-reads each owned file whenever it changes on disk (ADR-0005: hand edits
 * are tolerated). `onChange` runs when a reload changed the file's value or
 * problem. Returns a function that stops watching.
 */
export const watchOwnedFiles = (
  files: Watched[],
  onChange: (file: Watched) => void,
  onError: (error: unknown) => void,
): (() => void) => {
  const listeners = files.map((file) => {
    const listener = () => {
      file.reload().then((changed) => changed && onChange(file), onError);
    };
    watchFile(file.path, { interval: POLL_MS, persistent: false }, listener);
    return [file.path, listener] as const;
  });
  return () => {
    for (const [path, listener] of listeners) unwatchFile(path, listener);
  };
};
