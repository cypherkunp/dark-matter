/** Shortens a home-directory path to `~/…` for display. */
export const tildify = (path: string) => path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
