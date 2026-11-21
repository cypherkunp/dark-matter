import { CoreExitCode, CoreLocked } from "@dark-matter/contracts";
import { startCore } from "./server";

// The core process entry point. Electron main runs it with its own binary and
// ELECTRON_RUN_AS_NODE=1 (ADR-0003); it's ready once core.json names its pid.
const log = (message: string) => process.stderr.write(`[dark-matter core] ${message}\n`);

try {
  const core = await startCore({ env: process.env });
  log(`serving ${core.libraryHome} on 127.0.0.1:${core.port}`);
  const shutdown = (signal: string) => {
    log(`${signal}: stopping`);
    core.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        log(`stop failed: ${String(error)}`);
        process.exit(CoreExitCode.failed);
      },
    );
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
} catch (error) {
  log(error instanceof Error ? error.message : String(error));
  process.exit(error instanceof CoreLocked ? CoreExitCode.locked : CoreExitCode.failed);
}
