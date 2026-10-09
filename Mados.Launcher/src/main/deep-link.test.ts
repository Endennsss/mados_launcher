import { describe, expect, it } from "vitest";
import { containsDeepLink } from "./deep-link";

describe("deep-link command line matching", () => {
  it("accepts uppercase SS14 schemes", () => {
    expect(containsDeepLink(["MADOS", "SS14S://station.example/round"])).toBe(true);
  });

  it("ignores unrelated arguments", () => {
    expect(containsDeepLink(["--safe-mode", "https://example.com"])).toBe(false);
  });
});
