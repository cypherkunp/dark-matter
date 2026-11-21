import type { CoreConnection } from "@dark-matter/contracts";

/** What the preload exposes to the renderer as `window.darkMatter`. */
export interface DarkMatterBridge {
  platform: string;
  /** Where the core is right now; waits while it (re)starts. */
  coreConnection(): Promise<CoreConnection>;
  /** Main asks to open a screen (e.g. a clicked notification); returns an unsubscribe. */
  onNavigate(listener: (path: string) => void): () => void;
  /** The native folder picker; null when cancelled. */
  chooseFolder(title: string): Promise<string | null>;
  /** Opens a folder in Finder (or the Linux file manager). */
  openFolder(path: string): Promise<void>;
}
