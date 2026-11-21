import type { CoreConnection } from "@dark-matter/contracts";

/** What the preload exposes to the renderer as `window.darkMatter`. */
export interface DarkMatterBridge {
  platform: string;
  /** Where the core is right now; waits while it (re)starts. */
  coreConnection(): Promise<CoreConnection>;
}
