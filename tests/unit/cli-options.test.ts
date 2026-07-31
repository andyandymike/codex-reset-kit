import { describe, expect, it } from "vitest";
import { CliArgumentError, parseCliArgs } from "../../src/cli-options.js";

describe("parseCliArgs", () => {
  it("defaults to help without making an account request", () => {
    expect(parseCliArgs([], {})).toMatchObject({ command: "help" });
  });

  it("requires exactly one redemption selector", () => {
    expect(() => parseCliArgs(["redeem", "--yes"], {})).toThrowError(CliArgumentError);
    expect(() => parseCliArgs(["redeem", "--next", "--earliest", "--yes"], {})).toThrowError(
      CliArgumentError,
    );
  });

  it("validates retry idempotency keys", () => {
    expect(() =>
      parseCliArgs(["redeem", "--next", "--idempotency-key", "not-a-uuid"], {}),
    ).toThrowError(/valid UUID/);
  });

  it("limits idempotent recovery to parameters that preserve the original request", () => {
    expect(() =>
      parseCliArgs(
        ["redeem", "--earliest", "--idempotency-key", "8ae96ff3-3425-4f4c-8772-b6fd61502868"],
        {},
      ),
    ).toThrowError(/requires --credit-id/);
  });

  it("rejects redemption flags on read-only commands", () => {
    expect(() => parseCliArgs(["list", "--next"], {})).toThrowError(/not valid for list/);
  });

  it("requires a real calendar date", () => {
    expect(() => parseCliArgs(["redeem", "--expires-on", "2026-02-30"], {})).toThrowError(
      /real date/,
    );
  });
});
