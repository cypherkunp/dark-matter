import { createTRPCClient, createWSClient, type TRPCClient, wsLink } from "@trpc/client";
import type { AppRouter } from "./router";
import type { ClientKind, ConnectionParams, CoreConnection } from "./schemas";

export interface CoreClientOptions {
  /**
   * Where the core is. A function is called again on every reconnect, so a
   * client follows a core that restarted on a new port with a new token.
   */
  connection: CoreConnection | (() => Promise<CoreConnection>);
  client: ClientKind;
  /** The Agent behind an `mcp` or `cli` client, recorded with its Requests and in the Activity Log. */
  agent?: string;
  onOpen?: () => void;
  onClose?: () => void;
}

export interface CoreClient {
  trpc: TRPCClient<AppRouter>;
  close(): Promise<void>;
}

/** The one tRPC client every Dark Matter surface uses to talk to the core. */
export const createCoreClient = (options: CoreClientOptions): CoreClient => {
  const resolve =
    typeof options.connection === "function" ? options.connection : async () => options.connection as CoreConnection;
  // `url` runs first on each connect; reuse its answer for the token so a
  // restart between the two calls can't pair one core's port with another's token.
  let current: Promise<CoreConnection> | undefined;
  const ws = createWSClient({
    url: async () => {
      current = resolve();
      return `ws://127.0.0.1:${(await current).port}`;
    },
    connectionParams: async (): Promise<ConnectionParams> => ({
      token: (await (current ?? resolve())).token,
      client: options.client,
      ...(options.agent && { agent: options.agent }),
    }),
    ...(options.onOpen && { onOpen: options.onOpen }),
    ...(options.onClose && { onClose: options.onClose }),
  });
  return {
    trpc: createTRPCClient<AppRouter>({ links: [wsLink({ client: ws })] }),
    close: () => ws.close(),
  };
};
