import { TRPCClientError } from "@trpc/client";
import { describe, expect, test } from "vitest";
import { bootCore, connect, tempHome } from "./harness";

describe("connecting to the core", () => {
  test("rejects a connection with the wrong token", async () => {
    const { home, libraryHome } = await tempHome();
    const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });

    const { trpc } = connect({ port: core.port, token: "x".repeat(43) });
    // The core closes the connection as soon as the token fails, so the call never runs.
    await expect(trpc.core.info.query()).rejects.toBeInstanceOf(TRPCClientError);
  });

  test("rejects a connection that sends no token", async () => {
    const { home, libraryHome } = await tempHome();
    const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });

    // A plain WebSocket, as any local web page could open: no connectionParams.
    const socket = new WebSocket(`ws://127.0.0.1:${core.port}`);
    const closed = new Promise<number>((resolve) => socket.addEventListener("close", (e) => resolve(e.code)));
    const replies: unknown[] = [];
    socket.addEventListener("message", (e) => replies.push(JSON.parse(String(e.data))));
    socket.addEventListener("open", () =>
      socket.send(JSON.stringify({ id: 1, method: "query", params: { path: "core.info", input: null } })),
    );

    await closed;
    expect(replies).not.toContainEqual(expect.objectContaining({ id: 1, result: expect.anything() }));
    expect(replies).toContainEqual(
      expect.objectContaining({
        error: expect.objectContaining({ data: expect.objectContaining({ code: "UNAUTHORIZED" }) }),
      }),
    );
  });
});
