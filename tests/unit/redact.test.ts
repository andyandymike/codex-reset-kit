import { describe, expect, it } from "vitest";
import { redactText, redactUnknown, safeTerminalField } from "../../src/security/redact.js";

describe("redaction", () => {
  it("redacts common token forms in diagnostics", () => {
    const text = redactText(
      "Authorization: Bearer abc.def.ghi sk-abcdefghijklmnopqrstuvwxyz eyJabcdefghijk.abcdefghijk.abcdefghijk user@example.test",
    );
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(text).not.toContain("user@example.test");
    expect(text).toContain("[REDACTED");
  });

  it("redacts sensitive fields", () => {
    expect(redactUnknown({ accessToken: "secret", publicValue: "safe-to-return" })).toEqual({
      accessToken: "[REDACTED]",
      publicValue: "safe-to-return",
    });
  });

  it("neutralizes terminal control sequences and line injection", () => {
    const value = safeTerminalField("credit\u001b[2J\u202eflip\nFORGED");
    expect(value).not.toContain("\u001b");
    expect(value).not.toContain("\u202e");
    expect(value).not.toContain("\n");
    expect(value).toContain("FORGED");
  });
});
