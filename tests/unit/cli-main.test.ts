import { describe, expect, it } from "vitest";
import { EXIT_CODE } from "../../src/application/output.js";
import { runCli } from "../../src/cli-main.js";

function captureWriter(): {
  stream: Pick<NodeJS.WriteStream, "write">;
  value: () => string;
} {
  let output = "";
  const stream = {
    write(chunk: string | Uint8Array): boolean {
      output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
  } as Pick<NodeJS.WriteStream, "write">;
  return { stream, value: () => output };
}

describe("runCli safe entry paths", () => {
  it("prints help without connecting to App Server", async () => {
    const stdout = captureWriter();
    let connected = false;
    const exitCode = await runCli([], {
      stdout: stdout.stream,
      connect: async () => {
        connected = true;
        throw new Error("should not connect");
      },
    });
    expect(exitCode).toBe(0);
    expect(stdout.value()).toContain("Codex Reset Kit");
    expect(connected).toBe(false);
  });

  it("returns machine-readable argument errors without connecting", async () => {
    const stdout = captureWriter();
    const stderr = captureWriter();
    let connected = false;
    const exitCode = await runCli(["redeem", "--next", "--earliest", "--json"], {
      stdout: stdout.stream,
      stderr: stderr.stream,
      connect: async () => {
        connected = true;
        throw new Error("should not connect");
      },
    });
    expect(exitCode).toBe(EXIT_CODE.arguments);
    expect(JSON.parse(stdout.value())).toMatchObject({
      command: "redeem",
      ok: false,
      error: { code: "invalid-arguments" },
    });
    expect(stderr.value()).toBe("");
    expect(connected).toBe(false);
  });
});
