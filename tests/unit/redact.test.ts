import { describe, expect, it } from "vitest";
import { redactText, redactUnknown } from "../../src/security/redact.js";

describe("redaction", () => {
  it("redacts common token forms in diagnostics", () => {
    const text = redactText(
      "Authorization: Bearer abc.def.ghi sk-abcdefghijklmnopqrstuvwxyz eyJabcdefghijk.abcdefghijk.abcdefghijk user@example.test",
    );
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(text).not.toContain("user@example.test");
    expect(text).toContain("[REDACTED");
  });

  it("redacts sensitive fields but preserves idempotency keys", () => {
    expect(redactUnknown({ accessToken: "secret", idempotencyKey: "safe-to-return" })).toEqual({
      accessToken: "[REDACTED]",
      idempotencyKey: "safe-to-return",
    });
  });
});
