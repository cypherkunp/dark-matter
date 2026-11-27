import { describe, expect, test } from "vitest";
import { describeFetchError } from "../src/fetch-error";

describe("describeFetchError", () => {
  test("says why undici's bare 'fetch failed' failed, from its cause", () => {
    const cause = Object.assign(new Error("self signed certificate in certificate chain"), {
      code: "SELF_SIGNED_CERT_IN_CHAIN",
    });
    expect(describeFetchError(new TypeError("fetch failed", { cause }))).toBe(
      "self signed certificate in certificate chain (SELF_SIGNED_CERT_IN_CHAIN)",
    );
  });

  test("doesn't repeat a code the cause's message already carries", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
    expect(describeFetchError(new TypeError("fetch failed", { cause }))).toBe("connect ECONNREFUSED 127.0.0.1:1");
  });

  test("falls back to the error's own message, or the value as text", () => {
    expect(describeFetchError(new Error("The operation timed out"))).toBe("The operation timed out");
    expect(describeFetchError("nope")).toBe("nope");
  });
});
