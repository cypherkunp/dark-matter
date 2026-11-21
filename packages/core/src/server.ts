import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { ConnectionParams, type CoreEvent, CoreFile, Unauthorized } from "@dark-matter/contracts";
import { type CoreEnv, corePaths, resolveLibraryHome } from "@dark-matter/contracts/paths";
import { type CoreContext, createAppRouter } from "@dark-matter/contracts/router";
import { TRPCError } from "@trpc/server";
import { applyWSSHandler, type CreateWSSContextFnOptions } from "@trpc/server/adapters/ws";
import { WebSocketServer } from "ws";
import pkg from "../package.json" with { type: "json" };
import { writeFileAtomic } from "./atomic";
import { type Clock, systemClock } from "./clock";
import { EventBus } from "./events";
import { acquireCoreLock } from "./lock";
import { NotificationBus, type Notifier } from "./notifier";
import { defaultSecretStore, type SecretStore } from "./secrets";
import { createServices, type Services } from "./services";

export interface StartCoreOptions {
  env: CoreEnv;
  /** Defaults to the system clock; tests pass a controllable one. */
  clock?: Clock;
  /** Defaults to asking the app over the `events` subscription; tests pass a fake. */
  notifier?: Notifier;
  /** Defaults to the OS keychain (`DARK_MATTER_SECRETS=memory` for an in-memory one); tests pass a fake. */
  secrets?: SecretStore;
}

export interface RunningCore {
  readonly libraryHome: string;
  readonly port: number;
  readonly token: string;
  /** Pushes an event to every `events` subscriber. */
  publish(event: CoreEvent): void;
  /** Closes every connection, removes `core.json` and releases `core.lock`. */
  stop(): Promise<void>;
}

const sameToken = (expected: Buffer, given: string) => {
  const actual = Buffer.from(given);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

/** Boots the headless core (ADR-0003): serves tRPC on loopback and publishes `core.json`. */
export const startCore = async ({
  env,
  clock = systemClock,
  notifier,
  secrets,
}: StartCoreOptions): Promise<RunningCore> => {
  const libraryHome = resolveLibraryHome(env);
  const home = env.HOME || homedir();
  const paths = corePaths(libraryHome);
  await mkdir(libraryHome, { recursive: true, mode: 0o700 });
  const releaseLock = await acquireCoreLock(paths.lock);
  try {
    const startedAt = new Date().toISOString();
    const bus = new EventBus();
    const notifications = new NotificationBus();
    const core = await createServices({
      libraryHome,
      home,
      bus,
      clock,
      notifier: notifier ?? notifications,
      secrets: secrets ?? defaultSecretStore(env),
      info: () => ({ version: pkg.version, pid: process.pid, libraryHome, startedAt }),
    });
    try {
      return await serve(paths, bus, notifications, core, async () => {
        await core.close();
        await releaseLock();
      });
    } catch (error) {
      await core.close();
      throw error;
    }
  } catch (error) {
    await releaseLock();
    throw error;
  }
};

const serve = async (
  paths: ReturnType<typeof corePaths>,
  bus: EventBus,
  notifications: NotificationBus,
  core: Services,
  /** Closes the services and releases `core.lock`. */
  release: () => Promise<void>,
): Promise<RunningCore> => {
  const token = randomBytes(32).toString("base64url");
  const tokenBytes = Buffer.from(token);
  const router = createAppRouter({
    ...core.services,
    events: (signal) => bus.subscribe(signal),
    notifications: (signal) => notifications.subscribe(signal),
  });

  const createContext = ({ info }: CreateWSSContextFnOptions): CoreContext => {
    const params = ConnectionParams.safeParse(info.connectionParams);
    if (!params.success || !sameToken(tokenBytes, params.data.token)) {
      throw new TRPCError({ code: "UNAUTHORIZED", cause: new Unauthorized() });
    }
    return { client: params.data.client };
  };

  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });
  const handler = applyWSSHandler({ wss, router, createContext });
  const address = wss.address();
  if (typeof address !== "object" || address === null) throw new Error("WebSocket server has no port");
  const coreFile: CoreFile = { pid: process.pid, port: address.port, token, version: pkg.version };
  await writeFileAtomic(paths.coreFile, `${JSON.stringify(coreFile, null, 2)}\n`, 0o600);

  let stopped: Promise<void> | undefined;
  const stop = async () => {
    handler.broadcastReconnectNotification();
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await removeIfOurs(paths.coreFile, token);
    await release();
  };

  return {
    libraryHome: core.services.info().libraryHome,
    port: address.port,
    token,
    publish: (event) => bus.publish(event),
    stop: () => (stopped ??= stop()),
  };
};

/** Removes `core.json` only if it still describes this core. */
const removeIfOurs = async (path: string, token: string) => {
  try {
    const current = CoreFile.safeParse(JSON.parse(await readFile(path, "utf8")));
    if (current.success && current.data.token === token) await rm(path, { force: true });
  } catch {
    // Already gone or unreadable: nothing of ours to remove.
  }
};
