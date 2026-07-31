import { describe, expect, it } from "vitest";
import { verifyRedemption } from "../../src/domain/verification.js";
import {
  AUGUST_1_2026_UTC,
  AUGUST_2_2026_UTC,
  OBSERVED_AT_MS,
  redemptionAttempt,
  resetCredit,
  snapshot,
} from "../helpers.js";

describe("verifyRedemption", () => {
  it("verifies the exact target disappearing with one count and one strong window reset", () => {
    const attempt = redemptionAttempt();
    const after = snapshot({
      availableCount: 1,
      credits: [resetCredit("credit-2", AUGUST_2_2026_UTC)],
      usedPercent: 0,
      resetsAt: AUGUST_2_2026_UTC + 604_800,
    });
    expect(verifyRedemption(attempt, after, OBSERVED_AT_MS + 1_000)).toMatchObject({
      status: "verified",
      availableCountDelta: 1,
      targetAvailableAfter: false,
      changedWindows: ["codex:primary"],
    });
  });

  it("does not verify when another card disappears but the prepared target remains", () => {
    const attempt = redemptionAttempt();
    const after = snapshot({
      availableCount: 1,
      credits: [resetCredit("credit-1", AUGUST_1_2026_UTC)],
      usedPercent: 0,
      resetsAt: AUGUST_2_2026_UTC + 604_800,
    });
    expect(verifyRedemption(attempt, after, OBSERVED_AT_MS + 1_000)).toMatchObject({
      status: "partial",
      targetAvailableAfter: true,
    });
  });

  it("reports partial evidence when multiple credits disappear", () => {
    const attempt = redemptionAttempt();
    const result = verifyRedemption(
      attempt,
      snapshot({
        availableCount: 0,
        credits: [],
        usedPercent: 0,
        resetsAt: AUGUST_2_2026_UTC + 604_800,
      }),
      OBSERVED_AT_MS + 1_000,
    );
    expect(result.status).toBe("partial");
    expect(result.notes.join(" ")).toContain("More than one");
  });

  it("is unverified without a post-consume snapshot", () => {
    expect(verifyRedemption(redemptionAttempt(), null).status).toBe("unverified");
  });

  it("does not treat an unavailable post-consume count as zero", () => {
    const after = snapshot({ usedPercent: 0, resetsAt: AUGUST_2_2026_UTC + 604_800 });
    after.resetCredits = {
      availableCount: 0,
      detailsState: "unavailable",
      credits: [],
      serviceReported: false,
    };
    const result = verifyRedemption(redemptionAttempt(), after, OBSERVED_AT_MS + 1_000);
    expect(result.availableCountDelta).toBeNull();
    expect(result.status).toBe("partial");
  });

  it("does not verify across a natural target expiry or window rollover", () => {
    const attempt = redemptionAttempt();
    const result = verifyRedemption(
      attempt,
      snapshot({
        availableCount: 1,
        credits: [resetCredit("credit-2", AUGUST_2_2026_UTC)],
        usedPercent: 0,
        resetsAt: AUGUST_2_2026_UTC + 604_800,
      }),
      (AUGUST_2_2026_UTC + 1) * 1_000,
    );
    expect(result.status).toBe("partial");
    expect(result.naturalRolloverPossible).toBe(true);
  });
});
