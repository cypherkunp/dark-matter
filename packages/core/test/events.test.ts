import type { CoreEvent } from "@dark-matter/contracts";
import { describe, expect, test } from "vitest";
import { bootCore, connect, tempHome } from "./harness";

describe("the events subscription", () => {
  test("pushes core events to every subscribed client", async () => {
    const { home, libraryHome } = await tempHome();
    const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });

    const received = (client: ReturnType<typeof connect>) =>
      new Promise<CoreEvent>((resolve, reject) => {
        const subscription = client.trpc.events.subscribe(undefined, {
          onStarted: () => started.push(true),
          onData: (event) => {
            subscription.unsubscribe();
            resolve(event);
          },
          onError: reject,
        });
      });
    const started: boolean[] = [];
    const first = received(connect(core));
    const second = received(connect(core));
    await expect.poll(() => started.length).toBe(2);

    core.publish({ type: "invalidate", domains: ["library"] });

    const expected = { type: "invalidate", domains: ["library"] };
    await expect(first).resolves.toEqual(expected);
    await expect(second).resolves.toEqual(expected);
  });
});
