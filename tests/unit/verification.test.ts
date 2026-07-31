import { describe, expect, it } from "vitest";
import { verifyRedemption } from "../../src/domain/verification.js";
import { AUGUST_2_2026_UTC, resetCredit, snapshot } from "../helpers.js";

describe("verifyRedemption", () => {
  it("verifies one credit disappearing and a rate-limit window resetting", () => {
    const before = snapshot();
    const after = snapshot({
      availableCount: 1,
      credits: [resetCredit("credit-2", AUGUST_2_2026_UTC)],
      usedPercent: 0,
      resetsAt: AUGUST_2_2026_UTC + 604_800,
    });
    expect(verifyRedemption("reset", before, after)).toMatchObject({
      status: "verified",
      availableCountDelta: 1,
      changedWindows: ["codex:primary"],
    });
  });

  it("reports partial evidence when multiple credits disappear", () => {
    const result = verifyRedemption(
      "reset",
      snapshot(),
      snapshot({
        availableCount: 0,
        credits: [],
        usedPercent: 0,
        resetsAt: AUGUST_2_2026_UTC + 604_800,
      }),
    );
    expect(result.status).toBe("partial");
    expect(result.notes.join(" ")).toContain("More than one");
  });

  it("does not claim an idempotent replay was observed again", () => {
    expect(verifyRedemption("alreadyRedeemed", snapshot(), snapshot()).status).toBe("unverified");
  });

  it("is unverified without a post-consume snapshot", () => {
    expect(verifyRedemption("reset", snapshot(), null).status).toBe("unverified");
  });

  it("does not treat an omitted post-consume count as zero", () => {
    const after = snapshot({
      usedPercent: 0,
      resetsAt: AUGUST_2_2026_UTC + 604_800,
    });
    after.resetCredits = {
      availableCount: 0,
      detailsState: "unavailable",
      credits: [],
      serviceReported: false,
    };
    const result = verifyRedemption("reset", snapshot(), after);
    expect(result.availableCountDelta).toBeNull();
    expect(result.status).toBe("partial");
  });
});
