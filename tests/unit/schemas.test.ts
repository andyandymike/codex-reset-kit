import { describe, expect, it } from "vitest";
import { parseRateLimitSnapshot } from "../../src/app-server/schemas.js";
import { resetCredit } from "../helpers.js";

describe("rate-limit response normalization", () => {
  it("distinguishes null, empty, partial, and available detail states", () => {
    const parseCredits = (availableCount: number, credits: unknown) =>
      parseRateLimitSnapshot({
        rateLimitResetCredits: { availableCount, credits },
      }).resetCredits.detailsState;

    expect(parseCredits(2, null)).toBe("unavailable");
    expect(parseCredits(0, [])).toBe("empty");
    expect(parseCredits(2, [resetCredit("one", null)])).toBe("partial");
    expect(parseCredits(1, [resetCredit("one", null)])).toBe("available");
  });

  it("treats availableCount as authoritative", () => {
    const parsed = parseRateLimitSnapshot({
      rateLimitResetCredits: {
        availableCount: 4,
        credits: [resetCredit("one", null)],
      },
    });
    expect(parsed.resetCredits.availableCount).toBe(4);
    expect(parsed.resetCredits.credits).toHaveLength(1);
  });
});
