import { describe, expect, it } from "vitest";
import type { CodexAppServerClient, ConsumeResetParams } from "../../src/app-server/client.js";
import { AppServerError } from "../../src/app-server/errors.js";
import type { AccountSnapshot } from "../../src/app-server/schemas.js";
import { EXIT_CODE } from "../../src/application/output.js";
import { runRedeem } from "../../src/application/redeem.js";
import type { RateLimitSnapshot } from "../../src/domain/rate-limit.js";
import { AUGUST_2_2026_UTC, resetCredit, snapshot } from "../helpers.js";

class FakeClient implements CodexAppServerClient {
  readonly account: AccountSnapshot = {
    type: "chatgpt",
    planType: "plus",
    requiresOpenaiAuth: true,
  };
  readonly snapshots: RateLimitSnapshot[];
  readonly outcome: string;
  readonly consumeError: Error | null;
  readIndex = 0;
  consumeCalls: ConsumeResetParams[] = [];

  constructor(
    snapshots: RateLimitSnapshot[],
    outcome = "reset",
    consumeError: Error | null = null,
  ) {
    this.snapshots = snapshots;
    this.outcome = outcome;
    this.consumeError = consumeError;
  }

  async readAccount(): Promise<AccountSnapshot> {
    return this.account;
  }

  async readRateLimits(): Promise<RateLimitSnapshot> {
    const value = this.snapshots[Math.min(this.readIndex, this.snapshots.length - 1)];
    this.readIndex += 1;
    if (value == null) {
      throw new Error("missing fake snapshot");
    }
    return value;
  }

  async consumeResetCredit(params: ConsumeResetParams): Promise<string> {
    this.consumeCalls.push(params);
    if (this.consumeError != null) {
      throw this.consumeError;
    }
    return this.outcome;
  }

  close(): void {}
}

function verifiedAfter(): RateLimitSnapshot {
  return snapshot({
    availableCount: 1,
    credits: [resetCredit("credit-2", AUGUST_2_2026_UTC)],
    usedPercent: 0,
    resetsAt: AUGUST_2_2026_UTC + 604_800,
  });
}

describe("runRedeem", () => {
  it("never consumes without confirmation", async () => {
    const client = new FakeClient([snapshot()]);
    const execution = await runRedeem(client, {
      selector: { kind: "id", id: "credit-1" },
      confirm: async () => false,
      verificationDelaysMs: [],
    });
    expect(execution.exitCode).toBe(EXIT_CODE.cancelled);
    expect(client.consumeCalls).toHaveLength(0);
  });

  it("consumes once and verifies from a fresh snapshot", async () => {
    const client = new FakeClient([snapshot(), verifiedAfter()]);
    const execution = await runRedeem(client, {
      selector: { kind: "id", id: "credit-1" },
      idempotencyKey: "8ae96ff3-3425-4f4c-8772-b6fd61502868",
      confirm: async () => true,
      verificationDelaysMs: [],
    });
    expect(execution.exitCode).toBe(0);
    expect(execution.envelope.verification?.status).toBe("verified");
    expect(client.consumeCalls).toEqual([
      {
        idempotencyKey: "8ae96ff3-3425-4f4c-8772-b6fd61502868",
        creditId: "credit-1",
      },
    ]);
  });

  it("returns an unknown outcome with the same key after a sent timeout", async () => {
    const timeout = new AppServerError("timeout", "timed out", { requestSent: true });
    const client = new FakeClient([snapshot()], "reset", timeout);
    const execution = await runRedeem(client, {
      selector: { kind: "next" },
      idempotencyKey: "8ae96ff3-3425-4f4c-8772-b6fd61502868",
      confirm: async () => true,
      verificationDelaysMs: [],
    });
    expect(execution.exitCode).toBe(EXIT_CODE.outcomeUnknown);
    expect(execution.envelope.redemption?.idempotencyKey).toBe(
      "8ae96ff3-3425-4f4c-8772-b6fd61502868",
    );
    expect(client.consumeCalls).toHaveLength(1);
  });

  it("fails closed before confirmation when detail rows are partial", async () => {
    const client = new FakeClient([
      snapshot({
        availableCount: 2,
        credits: [resetCredit("credit-1", AUGUST_2_2026_UTC)],
      }),
    ]);
    const execution = await runRedeem(client, {
      selector: { kind: "id", id: "credit-1" },
      confirm: async () => true,
      verificationDelaysMs: [],
    });
    expect(execution.exitCode).toBe(EXIT_CODE.detailsUnavailable);
    expect(client.consumeCalls).toHaveLength(0);
  });

  it("can replay an exact ID with the same key after the credit disappeared", async () => {
    const afterOriginalAttempt = snapshot({
      availableCount: 1,
      credits: [resetCredit("credit-2", AUGUST_2_2026_UTC)],
      usedPercent: 0,
      resetsAt: AUGUST_2_2026_UTC + 604_800,
    });
    const client = new FakeClient([afterOriginalAttempt, afterOriginalAttempt], "alreadyRedeemed");
    const execution = await runRedeem(client, {
      selector: { kind: "id", id: "credit-1" },
      idempotencyKey: "8ae96ff3-3425-4f4c-8772-b6fd61502868",
      confirm: async () => true,
      verificationDelaysMs: [],
    });
    expect(execution.exitCode).toBe(EXIT_CODE.verificationIncomplete);
    expect(execution.envelope.redemption?.outcome).toBe("alreadyRedeemed");
    expect(client.consumeCalls).toEqual([
      {
        idempotencyKey: "8ae96ff3-3425-4f4c-8772-b6fd61502868",
        creditId: "credit-1",
      },
    ]);
  });
});
