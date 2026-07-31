import { describe, expect, it } from "vitest";
import { CreditSelectionError, selectCredit } from "../../src/domain/select-credit.js";
import { AUGUST_1_2026_UTC, AUGUST_2_2026_UTC, resetCredit, snapshot } from "../helpers.js";

describe("selectCredit", () => {
  it("selects a complete, available credit by opaque ID", () => {
    const selected = selectCredit(snapshot(), { kind: "id", id: "credit-2" });
    expect(selected.creditId).toBe("credit-2");
  });

  it("fails closed when details are unavailable", () => {
    expect(() =>
      selectCredit(snapshot({ availableCount: 2, credits: null }), {
        kind: "earliest",
      }),
    ).toThrowError(CreditSelectionError);
  });

  it("fails closed when detail rows are partial", () => {
    try {
      selectCredit(
        snapshot({
          availableCount: 2,
          credits: [resetCredit("credit-1", AUGUST_1_2026_UTC)],
        }),
        { kind: "id", id: "credit-1" },
      );
      throw new Error("expected selection to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "details-unavailable" });
    }
  });

  it("selects the uniquely earliest expiration", () => {
    const selected = selectCredit(snapshot(), { kind: "earliest" });
    expect(selected.creditId).toBe("credit-1");
  });

  it("requires an ID when earliest expiration is tied", () => {
    const tied = snapshot({
      credits: [
        resetCredit("credit-a", AUGUST_1_2026_UTC),
        resetCredit("credit-b", AUGUST_1_2026_UTC),
      ],
    });
    try {
      selectCredit(tied, { kind: "earliest" });
      throw new Error("expected selection to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "ambiguous" });
    }
  });

  it("matches expiration by calendar date in the chosen IANA time zone", () => {
    const credits = [resetCredit("utc-midnight", AUGUST_1_2026_UTC)];
    const selected = selectCredit(snapshot({ availableCount: 1, credits }), {
      kind: "expires-on",
      date: "2026-07-31",
      timeZone: "America/Los_Angeles",
    });
    expect(selected.creditId).toBe("utc-midnight");
  });

  it("ignores unavailable detail rows", () => {
    const credits = [
      resetCredit("used", AUGUST_1_2026_UTC, "redeemed"),
      resetCredit("available", AUGUST_2_2026_UTC),
    ];
    expect(
      selectCredit(snapshot({ availableCount: 1, credits }), { kind: "earliest" }).creditId,
    ).toBe("available");
  });

  it("does not let historical rows disguise a missing available credit", () => {
    const credits = [
      resetCredit("used", AUGUST_1_2026_UTC, "redeemed"),
      resetCredit("known", AUGUST_2_2026_UTC),
    ];
    expect(() =>
      selectCredit(snapshot({ availableCount: 2, credits }), { kind: "earliest" }),
    ).toThrowError(/Complete reset-credit details are unavailable/);
  });

  it("fails closed on duplicate IDs and unsupported available reset types", () => {
    const duplicate = resetCredit("same", AUGUST_1_2026_UTC);
    expect(() =>
      selectCredit(snapshot({ availableCount: 2, credits: [duplicate, duplicate] }), {
        kind: "earliest",
      }),
    ).toThrowError(/Complete reset-credit details are unavailable/);

    const unsupported = { ...resetCredit("other", AUGUST_1_2026_UTC), resetType: "futureType" };
    expect(() =>
      selectCredit(snapshot({ availableCount: 1, credits: [unsupported] }), { kind: "earliest" }),
    ).toThrowError(/Complete reset-credit details are unavailable/);
  });
});
