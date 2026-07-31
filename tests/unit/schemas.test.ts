import { describe, expect, it } from "vitest";
import { parseConsumeOutcome, parseRateLimitSnapshot } from "../../src/app-server/schemas.js";
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

  it("marks duplicate, excess, unknown-status, and unsupported-type details inconsistent", () => {
    const duplicate = resetCredit("same", null);
    const parseCredits = (availableCount: number, credits: unknown) =>
      parseRateLimitSnapshot({ rateLimitResetCredits: { availableCount, credits } }).resetCredits
        .detailsState;

    expect(parseCredits(2, [duplicate, duplicate])).toBe("inconsistent");
    expect(parseCredits(1, [resetCredit("one", null), resetCredit("two", null)])).toBe(
      "inconsistent",
    );
    expect(parseCredits(1, [resetCredit("one", null, "futureStatus")])).toBe("inconsistent");
    expect(parseCredits(1, [{ ...resetCredit("one", null), resetType: "futureResetType" }])).toBe(
      "inconsistent",
    );
  });

  it("treats unknown consume outcomes as protocol incompatibility", () => {
    expect(() => parseConsumeOutcome({ outcome: "futureSuccess" })).toThrow();
  });

  it("rejects control characters in opaque protocol strings", () => {
    expect(() =>
      parseRateLimitSnapshot({
        rateLimitResetCredits: {
          availableCount: 1,
          credits: [resetCredit("safe\u001b[2Jfake", null)],
        },
      }),
    ).toThrow();
    expect(() =>
      parseRateLimitSnapshot({
        rateLimitResetCredits: {
          availableCount: 1,
          credits: [resetCredit("safe\u202efake", null)],
        },
      }),
    ).toThrow();
  });

  it("rejects timestamps that cannot be presented as a credible account date", () => {
    expect(() =>
      parseRateLimitSnapshot({
        rateLimitResetCredits: {
          availableCount: 1,
          credits: [resetCredit("safe", 253_402_300_800)],
        },
      }),
    ).toThrow();
  });

  it("rejects implausible percentages and oversized credit inventories", () => {
    expect(() =>
      parseRateLimitSnapshot({ rateLimits: { primary: { usedPercent: 101 } } }),
    ).toThrow();
    expect(() =>
      parseRateLimitSnapshot({
        rateLimitResetCredits: {
          availableCount: 1_025,
          credits: Array.from({ length: 1_025 }, (_, index) =>
            resetCredit(`credit-${index}`, null),
          ),
        },
      }),
    ).toThrow();
  });
});
