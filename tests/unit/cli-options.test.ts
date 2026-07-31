import { describe, expect, it } from "vitest";
import { CliArgumentError, parseCliArgs } from "../../src/cli-options.js";

const ATTEMPT = "8ae96ff3-3425-4f4c-8772-b6fd61502868";

describe("parseCliArgs", () => {
  it("defaults to help without making an account request", () => {
    expect(parseCliArgs([], {})).toMatchObject({ command: "help" });
  });

  it("requires exactly one precise selector", () => {
    expect(() => parseCliArgs(["redeem"], {})).toThrowError(CliArgumentError);
    expect(() => parseCliArgs(["redeem", "--earliest", "--credit-id", "x"], {})).toThrowError(
      CliArgumentError,
    );
  });

  it("does not expose yes, next, or caller-supplied idempotency keys", () => {
    expect(() => parseCliArgs(["redeem", "--earliest", "--yes"], {})).toThrowError(
      /Unknown option/,
    );
    expect(() => parseCliArgs(["redeem", "--next"], {})).toThrowError(/Unknown option/);
    expect(() =>
      parseCliArgs(["redeem", "--earliest", "--idempotency-key", ATTEMPT], {}),
    ).toThrowError(/Unknown option/);
  });

  it("requires a journaled attempt ID for commit and recover", () => {
    expect(parseCliArgs(["commit", "--attempt", ATTEMPT], {})).toMatchObject({
      command: "commit",
      attemptId: ATTEMPT,
    });
    expect(() => parseCliArgs(["recover", "--attempt", "new-key"], {})).toThrowError(
      /valid journaled attempt UUID/,
    );
  });

  it("rejects mutation options on read-only commands", () => {
    expect(() => parseCliArgs(["list", "--attempt", ATTEMPT], {})).toThrowError(
      /not valid for list/,
    );
  });

  it("requires a real calendar date", () => {
    expect(() => parseCliArgs(["prepare", "--expires-on", "2026-02-30"], {})).toThrowError(
      /real date/,
    );
  });
});
