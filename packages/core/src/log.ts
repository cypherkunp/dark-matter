/** The core's diagnostics go to stderr; Electron main forwards them. */
export const log = (message: string) => process.stderr.write(`[dark-matter core] ${message}\n`);
