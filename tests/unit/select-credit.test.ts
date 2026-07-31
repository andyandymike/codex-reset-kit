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

  it("allows only explicit service selection when details cannot prove a date", () => {
    const selected = selectCredit(snapshot({ availableCount: 2, credits: null }), {
      kind: "next",
    });
    expect(selected.creditId).toBeNull();
    expect(selected.warnings[0]).toContain("cannot prove");
  });

  it("reports no credit instead of asking the service to choose", () => {
    expect(() =>
      selectCredit(snapshot({ availableCount: 0, credits: [] }), { kind: "next" }),
    ).toThrowError(/No earned reset credits/);
  });

  it("ignores unavailable detail rows", () => {
    const credits = [
      resetCredit("used", AUGUST_1_2026_UTC, "redeemed"),
      resetCredit("available", AUGUST_2_2026_UTC),
    ];
    expect(selectCredit(snapshot({ credits }), { kind: "earliest" }).creditId).toBe("available");
  });
});
