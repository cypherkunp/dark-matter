import { type ChildProcess, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { CoreConnection, CoreExitCode, CoreFile } from "@dark-matter/contracts";
import { createCoreClient } from "@dark-matter/contracts/client";

export interface CoreSupervisorOptions {
  /** `core.json` of the Library this app serves. */
  coreFilePath: string;
  /** The bundled core entry (`core/dist/main.mjs`). */
  coreEntry: string;
  /** Environment for a spawned core; ELECTRON_RUN_AS_NODE is added, NODE_USE_SYSTEM_CA defaulted. */
  env: NodeJS.ProcessEnv;
  log: (message: string) => void;
}

const READY_TIMEOUT_MS = 15_000;
const POLL_MS = 50;
const WATCH_ATTACHED_MS = 1_000;
const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 10_000;
/** A core that stayed up this long counts as healthy, and the backoff starts over. */
const HEALTHY_AFTER_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const readCoreFile = async (path: string): Promise<CoreFile | null> => {
  try {
    return CoreFile.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return null;
  }
};

/**
 * Keeps a core running for the app (ADR-0003). It attaches to a core that is
 * already running for this Library, or spawns one with the Electron binary in
 * Node mode. A core it spawned is restarted with backoff when it crashes; an
 * attached core that goes away is replaced by a spawned one.
 */
export class CoreSupervisor {
  readonly #options: CoreSupervisorOptions;
  #ready: Promise<CoreConnection>;
  #resolveReady!: (connection: CoreConnection) => void;
  #child: ChildProcess | undefined;
  #watch: NodeJS.Timeout | undefined;
  #failures = 0;
  #stopping = false;

  constructor(options: CoreSupervisorOptions) {
    this.#options = options;
    this.#ready = this.#pending();
  }

  /** Resolves once a core is reachable; waits through restarts. */
  connection(): Promise<CoreConnection> {
    return this.#ready;
  }

  start(): void {
    void this.#ensure();
  }

  /** Stops the core only if this app spawned it. */
  async stop(): Promise<void> {
    this.#stopping = true;
    clearInterval(this.#watch);
    const child = this.#child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([exited, sleep(5_000).then(() => child.kill("SIGKILL"))]);
  }

  #pending(): Promise<CoreConnection> {
    return new Promise((resolve) => {
      this.#resolveReady = resolve;
    });
  }

  async #ensure(): Promise<void> {
    if (this.#stopping) return;
    try {
      const attached = await this.#attach();
      if (attached) return;
      await this.#spawn();
    } catch (error) {
      this.#options.log(`core failed to start: ${String(error)}`);
      this.#restartLater();
    }
  }

  /** Attaches to a running core whose `core.json` answers with its token. */
  async #attach(): Promise<boolean> {
    const file = await readCoreFile(this.#options.coreFilePath);
    if (!file || !isAlive(file.pid) || !(await this.#answersWithToken(file))) return false;
    this.#options.log(`attached to running core (pid ${file.pid})`);
    this.#failures = 0;
    this.#markReady(file);
    this.#watch = setInterval(() => {
      if (isAlive(file.pid)) return;
      clearInterval(this.#watch);
      this.#options.log(`attached core (pid ${file.pid}) went away`);
      this.#lost();
      void this.#ensure();
    }, WATCH_ATTACHED_MS);
    return true;
  }

  async #answersWithToken(connection: CoreConnection): Promise<boolean> {
    const client = createCoreClient({ connection, client: "app" });
    try {
      await Promise.race([
        client.trpc.core.info.query(),
        sleep(2_000).then(() => Promise.reject(new Error("timed out"))),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      void client.close();
    }
  }

  async #spawn(): Promise<void> {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [this.#options.coreEntry], {
      // NODE_USE_SYSTEM_CA: Node ships its own CA list, so behind a TLS-inspecting
      // proxy (Netskope, Zscaler) every fetch to GitHub or skills.sh fails with
      // "self signed certificate in certificate chain". The system store has the
      // proxy's CA. An explicit value in the environment still wins.
      env: { NODE_USE_SYSTEM_CA: "1", ...this.#options.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "inherit", "inherit"],
    });
    this.#child = child;
    child.once("exit", (code, signal) => {
      if (this.#child !== child) return;
      this.#child = undefined;
      if (this.#stopping) return;
      this.#lost();
      // A "locked" exit means another core holds the lock; the next attempt
      // attaches to it. It still waits out the backoff, so a lock held by a
      // core that never answers can't turn into a tight respawn loop.
      this.#options.log(
        code === CoreExitCode.locked ? "another core holds core.lock" : `core exited (code ${code}, signal ${signal})`,
      );
      if (Date.now() - startedAt > HEALTHY_AFTER_MS) this.#failures = 0;
      this.#restartLater();
    });

    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (this.#child === child && Date.now() < deadline) {
      const file = await readCoreFile(this.#options.coreFilePath);
      if (file && file.pid === child.pid) {
        this.#options.log(`spawned core (pid ${child.pid})`);
        this.#markReady(file);
        return;
      }
      await sleep(POLL_MS);
    }
    if (this.#child === child) {
      this.#options.log("core did not publish core.json in time");
      child.kill("SIGKILL");
    }
  }

  #markReady(file: CoreFile): void {
    this.#resolveReady(CoreConnection.parse(file));
  }

  /** The current core is gone: callers wait for the next one. */
  #lost(): void {
    this.#ready = this.#pending();
  }

  #restartLater(): void {
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** this.#failures, BACKOFF_MAX_MS);
    this.#failures++;
    this.#options.log(`restarting core in ${delay} ms`);
    setTimeout(() => void this.#ensure(), delay);
  }
}
