import { describe, expect, test } from "vitest";
import { bootCore, connect, tempHome } from "./harness";

describe("the Library", () => {
  test("is empty in a fresh home", async () => {
    const { home, libraryHome } = await tempHome();
    const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });

    const { trpc } = connect(core);
    await expect(trpc.library.list.query()).resolves.toEqual({ skills: [] });
  });
});
