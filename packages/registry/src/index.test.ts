import { describe, expect, it } from "vitest";
import { buildCapabilityId } from "./index";

describe("capability identity", () => {
  it("is server scoped", () => {
    expect(buildCapabilityId("market-data", "tool", "search")).not.toBe(
      buildCapabilityId("economic-data", "tool", "search"),
    );
  });

  it("escapes arbitrary server and capability names", () => {
    expect(buildCapabilityId("server/a", "tool", "price curve")).toBe("server%2Fa/tool/price%20curve");
  });
});
