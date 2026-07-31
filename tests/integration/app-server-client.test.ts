import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type CodexAppServerClient, connectAppServer } from "../../src/app-server/client.js";
import { EXIT_CODE } from "../../src/application/output.js";
import { runRedeem } from "../../src/application/redeem.js";

const fixture = fileURLToPath(new URL("../fixtures/fake-app-server.mjs", import.meta.url));

async function connect(
  scenario: string,
  options: { timeoutMs?: number; diagnostics?: string[] } = {},
): Promise<CodexAppServerClient> {
  return connectAppServer({
    command: process.execPath,
    args: [fixture],
    env: { ...process.env, CODEX_RESET_FAKE_SCENARIO: scenario },
    timeoutMs: options.timeoutMs ?? 2_000,
    clientVersion: "test",
    ...(options.diagnostics == null
      ? {}
      : { onDiagnostic: (message: string) => options.diagnostics?.push(message) }),
  });
}

describe("stdio App Server client", () => {
  it("performs initialize, read, consume, and read using only the fixture", async () => {
    const client = await connect("happy");
    try {
      expect(await client.readAccount()).toEqual({
        type: "chatgpt",
        planType: "plus",
        requiresOpenaiAuth: true,
      });
      const before = await client.readRateLimits();
      expect(before.resetCredits.availableCount).toBe(2);
      expect(
        await client.consumeResetCredit({
          idempotencyKey: "8ae96ff3-3425-4f4c-8772-b6fd61502868",
          creditId: "fake-credit-1",
        }),
      ).toBe("reset");
      const after = await client.readRateLimits();
      expect(after.resetCredits.availableCount).toBe(1);
      expect(after.rateLimits?.primary?.usedPercent).toBe(0);
    } finally {
      client.close();
    }
  });

  it("ignores unrelated notifications and non-JSON stdout with diagnostics", async () => {
    const diagnostics: string[] = [];
    const client = await connect("noisy", { diagnostics });
    try {
      expect((await client.readRateLimits()).resetCredits.availableCount).toBe(2);
      expect(diagnostics.join(" ")).toContain("non-JSON");
    } finally {
      client.close();
    }
  });

  it("marks a timed-out consume as possibly sent without retrying", async () => {
    const client = await connect("timeout-after-consume", { timeoutMs: 1_000 });
    try {
      await expect(
        client.consumeResetCredit({
          idempotencyKey: "8ae96ff3-3425-4f4c-8772-b6fd61502868",
        }),
      ).rejects.toMatchObject({ kind: "timeout", requestSent: true });
    } finally {
      client.close();
    }
  });

  it("fails initialization on an explicit fixture RPC error", async () => {
    await expect(connect("init-fail")).rejects.toMatchObject({ kind: "rpc" });
  });

  it("verifies the full redemption flow against the fake process", async () => {
    const client = await connect("happy");
    try {
      const execution = await runRedeem(client, {
        selector: { kind: "id", id: "fake-credit-1" },
        confirm: async () => true,
        verificationDelaysMs: [],
      });
      expect(execution.exitCode).toBe(0);
      expect(execution.envelope.verification?.status).toBe("verified");
    } finally {
      client.close();
    }
  });

  it("uses bounded read-only retries for delayed verification", async () => {
    const client = await connect("delayed");
    try {
      const execution = await runRedeem(client, {
        selector: { kind: "id", id: "fake-credit-1" },
        confirm: async () => true,
        verificationDelaysMs: [0],
      });
      expect(execution.exitCode).toBe(0);
      expect(execution.envelope.verification?.status).toBe("verified");
    } finally {
      client.close();
    }
  });

  it.each([
    ["no-credit", EXIT_CODE.noCredit, "noCredit"],
    ["nothing", EXIT_CODE.nothingToReset, "nothingToReset"],
  ])(
    "maps the %s service outcome without claiming success",
    async (scenario, exitCode, outcome) => {
      const client = await connect(scenario);
      try {
        const execution = await runRedeem(client, {
          selector: { kind: "id", id: "fake-credit-1" },
          confirm: async () => true,
          verificationDelaysMs: [],
        });
        expect(execution.exitCode).toBe(exitCode);
        expect(execution.envelope.redemption?.outcome).toBe(outcome);
        expect(execution.envelope.verification?.status).toBe("failed");
      } finally {
        client.close();
      }
    },
  );

  it("does not claim verification when the fake service never updates", async () => {
    const client = await connect("never-update");
    try {
      const execution = await runRedeem(client, {
        selector: { kind: "id", id: "fake-credit-1" },
        confirm: async () => true,
        verificationDelaysMs: [],
      });
      expect(execution.exitCode).toBe(EXIT_CODE.verificationIncomplete);
      expect(execution.envelope.verification?.status).toBe("unverified");
    } finally {
      client.close();
    }
  });
});
