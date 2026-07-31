import { describe, expect, it } from "vitest";
import type { CodexAppServerClient, ConsumeResetParams } from "../../src/app-server/client.js";
import { AppServerError } from "../../src/app-server/errors.js";
import type { AccountSnapshot, ConsumeResetOutcome } from "../../src/app-server/schemas.js";
import {
  MemoryRedemptionAttemptStore,
  type RedemptionAttemptStore,
} from "../../src/application/attempt-store.js";
import { EXIT_CODE } from "../../src/application/output.js";
import {
  runCommitRedemption,
  runPrepareRedemption,
  runRecoverRedemption,
  runRedeem,
} from "../../src/application/redeem.js";
import type { RateLimitSnapshot } from "../../src/domain/rate-limit.js";
import type { RedemptionAttempt } from "../../src/domain/redemption-attempt.js";
import {
  AUGUST_1_2026_UTC,
  AUGUST_2_2026_UTC,
  chatgptAccount,
  OBSERVED_AT_MS,
  resetCredit,
  snapshot,
} from "../helpers.js";

class FakeClient implements CodexAppServerClient {
  readonly snapshots: RateLimitSnapshot[];
  readonly accounts: AccountSnapshot[];
  readonly outcome: ConsumeResetOutcome;
  readonly consumeError: Error | null;
  readonly onConsume: ((params: ConsumeResetParams) => Promise<void> | void) | null;
  readIndex = 0;
  accountIndex = 0;
  epoch = 0;
  consumeCalls: ConsumeResetParams[] = [];

  constructor(options: {
    snapshots: RateLimitSnapshot[];
    accounts?: AccountSnapshot[];
    outcome?: ConsumeResetOutcome;
    consumeError?: Error | null;
    onConsume?: ((params: ConsumeResetParams) => Promise<void> | void) | null;
  }) {
    this.snapshots = options.snapshots;
    this.accounts = options.accounts ?? [chatgptAccount];
    this.outcome = options.outcome ?? "reset";
    this.consumeError = options.consumeError ?? null;
    this.onConsume = options.onConsume ?? null;
  }

  async readAccount(): Promise<AccountSnapshot> {
    const value = this.accounts[Math.min(this.accountIndex, this.accounts.length - 1)];
    this.accountIndex += 1;
    if (value == null) {
      throw new Error("missing fake account");
    }
    return value;
  }

  async readRateLimits(): Promise<RateLimitSnapshot> {
    const value = this.snapshots[Math.min(this.readIndex, this.snapshots.length - 1)];
    this.readIndex += 1;
    if (value == null) {
      throw new Error("missing fake snapshot");
    }
    return value;
  }

  async consumeResetCredit(params: ConsumeResetParams): Promise<ConsumeResetOutcome> {
    this.consumeCalls.push(params);
    await this.onConsume?.(params);
    if (this.consumeError != null) {
      throw this.consumeError;
    }
    return this.outcome;
  }

  getAccountEpoch(): number {
    return this.epoch;
  }

  close(): void {}
}

class FailingTerminalSaveStore implements RedemptionAttemptStore {
  readonly inner = new MemoryRedemptionAttemptStore();

  create(attempt: RedemptionAttempt) {
    return this.inner.create(attempt);
  }

  read(attemptId: string) {
    return this.inner.read(attemptId);
  }

  save(attempt: RedemptionAttempt) {
    if (
      attempt.state === "completed" ||
      attempt.state === "rejected" ||
      attempt.state === "outcome-unknown"
    ) {
      throw new Error("simulated disk failure after send");
    }
    return this.inner.save(attempt);
  }

  withAccountLock<T>(fingerprint: string, attemptId: string, operation: () => Promise<T>) {
    return this.inner.withAccountLock(fingerprint, attemptId, operation);
  }
}

function verifiedAfter(): RateLimitSnapshot {
  return snapshot({
    availableCount: 1,
    credits: [resetCredit("credit-2", AUGUST_2_2026_UTC)],
    usedPercent: 0,
    resetsAt: AUGUST_2_2026_UTC + 604_800,
  });
}

function stableBefore(count = 3): RateLimitSnapshot[] {
  return Array.from({ length: count }, () => snapshot());
}

describe("journaled redemption", () => {
  it("never consumes without a local confirmation", async () => {
    const store = new MemoryRedemptionAttemptStore();
    const client = new FakeClient({ snapshots: stableBefore() });
    const execution = await runRedeem(client, store, {
      selector: { kind: "id", id: "credit-1" },
      timeZone: "UTC",
      confirm: async () => false,
      verificationDelaysMs: [],
      now: () => OBSERVED_AT_MS,
    });
    expect(execution.exitCode).toBe(EXIT_CODE.cancelled);
    expect(client.consumeCalls).toHaveLength(0);
    expect(execution.envelope.redemption?.state).toBe("stale");
  });

  it("persists an exact intent before sending and verifies the exact target", async () => {
    const store = new MemoryRedemptionAttemptStore();
    let attemptWasDurable = false;
    let preparedAttemptId: string | null = null;
    const client = new FakeClient({
      snapshots: [...stableBefore(), verifiedAfter()],
      onConsume: async (params) => {
        if (preparedAttemptId == null) {
          throw new Error("confirmation did not expose the prepared attempt");
        }
        const attempt = await store.read(preparedAttemptId);
        attemptWasDurable =
          attempt.state === "sending" &&
          attempt.idempotencyKey === params.idempotencyKey &&
          attempt.target.id === params.creditId;
      },
    });
    const execution = await runRedeem(client, store, {
      selector: { kind: "id", id: "credit-1" },
      timeZone: "UTC",
      confirm: async (attempt) => {
        preparedAttemptId = attempt.attemptId;
        return true;
      },
      verificationDelaysMs: [],
      now: () => OBSERVED_AT_MS,
    });
    expect(execution.exitCode).toBe(0);
    expect(execution.envelope.verification?.status).toBe("verified");
    expect(execution.envelope.redemption).not.toHaveProperty("idempotencyKey");
    expect(attemptWasDurable).toBe(true);
  });

  it("aborts when the selected target changes after confirmation", async () => {
    const store = new MemoryRedemptionAttemptStore();
    const changed = snapshot({
      availableCount: 1,
      credits: [resetCredit("credit-2", AUGUST_2_2026_UTC)],
    });
    const client = new FakeClient({ snapshots: [snapshot(), snapshot(), changed] });
    const execution = await runRedeem(client, store, {
      selector: { kind: "earliest" },
      timeZone: "UTC",
      confirm: async () => true,
      now: () => OBSERVED_AT_MS,
    });
    expect(execution.exitCode).toBe(EXIT_CODE.stale);
    expect(client.consumeCalls).toHaveLength(0);
    expect(execution.envelope.error?.code).toBe("prepared-state-changed");
  });

  it("aborts when the active account changes after confirmation", async () => {
    const store = new MemoryRedemptionAttemptStore();
    const otherAccount = { ...chatgptAccount, email: "other@example.test" };
    const client = new FakeClient({
      snapshots: stableBefore(),
      accounts: [chatgptAccount, chatgptAccount, otherAccount],
    });
    const execution = await runRedeem(client, store, {
      selector: { kind: "id", id: "credit-1" },
      timeZone: "UTC",
      confirm: async () => true,
      now: () => OBSERVED_AT_MS,
    });
    expect(execution.exitCode).toBe(EXIT_CODE.stale);
    expect(client.consumeCalls).toHaveLength(0);
  });

  it("aborts when the active plan changes after confirmation", async () => {
    const store = new MemoryRedemptionAttemptStore();
    const changedPlan = { ...chatgptAccount, planType: "pro" };
    const client = new FakeClient({
      snapshots: stableBefore(),
      accounts: [chatgptAccount, chatgptAccount, changedPlan],
    });
    const execution = await runRedeem(client, store, {
      selector: { kind: "id", id: "credit-1" },
      timeZone: "UTC",
      confirm: async () => true,
      now: () => OBSERVED_AT_MS,
    });
    expect(execution.exitCode).toBe(EXIT_CODE.stale);
    expect(execution.envelope.error?.message).toContain("plan changed");
    expect(client.consumeCalls).toHaveLength(0);
  });

  it("refuses workspace and unknown plans before creating redemption authority", async () => {
    for (const planType of ["enterprise", "business", "future-plan"]) {
      const store = new MemoryRedemptionAttemptStore();
      const client = new FakeClient({
        snapshots: [snapshot({ planType })],
        accounts: [{ ...chatgptAccount, planType }],
      });
      const execution = await runPrepareRedemption(client, store, {
        selector: { kind: "id", id: "credit-1" },
        timeZone: "UTC",
        now: () => OBSERVED_AT_MS,
      });
      expect(execution.exitCode).toBe(EXIT_CODE.authentication);
      expect(execution.envelope.error?.code).toBe("incompatible-account");
      expect(client.consumeCalls).toHaveLength(0);
    }

    const missingPlanClient = new FakeClient({
      snapshots: [snapshot({ planType: null })],
      accounts: [{ ...chatgptAccount, planType: null }],
    });
    const missingPlan = await runPrepareRedemption(
      missingPlanClient,
      new MemoryRedemptionAttemptStore(),
      {
        selector: { kind: "id", id: "credit-1" },
        timeZone: "UTC",
        now: () => OBSERVED_AT_MS,
      },
    );
    expect(missingPlan.exitCode).toBe(EXIT_CODE.authentication);
    expect(missingPlanClient.consumeCalls).toHaveLength(0);
  });

  it("refuses inconsistent plan values across account and rate-limit buckets", async () => {
    const inconsistent = snapshot();
    const bucket = inconsistent.rateLimitsByLimitId.codex;
    if (bucket == null) {
      throw new Error("missing fake bucket");
    }
    bucket.planType = "pro";
    const client = new FakeClient({ snapshots: [inconsistent] });
    const execution = await runPrepareRedemption(client, new MemoryRedemptionAttemptStore(), {
      selector: { kind: "id", id: "credit-1" },
      timeZone: "UTC",
      now: () => OBSERVED_AT_MS,
    });
    expect(execution.exitCode).toBe(EXIT_CODE.authentication);
    expect(execution.envelope.error?.code).toBe("inconsistent-plan");
    expect(client.consumeCalls).toHaveLength(0);
  });

  it("treats every sent RPC error as unknown and reconciles read-only", async () => {
    const store = new MemoryRedemptionAttemptStore();
    const rpcError = new AppServerError("rpc", "internal timeout", {
      requestSent: true,
      rpcCode: -32603,
    });
    const client = new FakeClient({
      snapshots: [...stableBefore(), verifiedAfter()],
      consumeError: rpcError,
    });
    const execution = await runRedeem(client, store, {
      selector: { kind: "id", id: "credit-1" },
      timeZone: "UTC",
      confirm: async () => true,
      verificationDelaysMs: [],
      now: () => OBSERVED_AT_MS,
    });
    expect(execution.exitCode).toBe(0);
    expect(execution.envelope.redemption?.state).toBe("completed");
    expect(execution.envelope.warnings.join(" ")).toContain("response was unknown");
  });

  it("retains an unknown attempt and never calls it an explicit rejection", async () => {
    const store = new MemoryRedemptionAttemptStore();
    const protocolError = new AppServerError("protocol", "future outcome", {
      requestSent: true,
    });
    const client = new FakeClient({ snapshots: stableBefore(4), consumeError: protocolError });
    const execution = await runRedeem(client, store, {
      selector: { kind: "id", id: "credit-1" },
      timeZone: "UTC",
      confirm: async () => true,
      verificationDelaysMs: [],
      now: () => OBSERVED_AT_MS,
    });
    expect(execution.exitCode).toBe(EXIT_CODE.outcomeUnknown);
    expect(execution.envelope.error?.code).toBe("consume-outcome-unknown");
    expect(execution.envelope.redemption?.state).toBe("outcome-unknown");
  });

  it("does not allow an arbitrary UUID to impersonate recovery", async () => {
    const store = new MemoryRedemptionAttemptStore();
    const client = new FakeClient({ snapshots: [snapshot()] });
    const execution = await runRecoverRedemption(client, store, {
      attemptId: "8ae96ff3-3425-4f4c-8772-b6fd61502868",
      confirm: async () => true,
      now: () => OBSERVED_AT_MS,
    });
    expect(execution.exitCode).toBe(EXIT_CODE.attempt);
    expect(client.consumeCalls).toHaveLength(0);
  });

  it("recovers only with the journaled key, target, and account", async () => {
    const store = new MemoryRedemptionAttemptStore();
    const firstClient = new FakeClient({
      snapshots: stableBefore(4),
      consumeError: new AppServerError("timeout", "timed out", { requestSent: true }),
    });
    const first = await runRedeem(firstClient, store, {
      selector: { kind: "id", id: "credit-1" },
      timeZone: "UTC",
      confirm: async () => true,
      verificationDelaysMs: [],
      now: () => OBSERVED_AT_MS,
    });
    const attemptId = first.envelope.redemption?.attemptId;
    expect(attemptId).toBeDefined();
    const journaled = await store.read(attemptId as string);

    const recoveryClient = new FakeClient({
      snapshots: [snapshot(), snapshot(), snapshot()],
      outcome: "alreadyRedeemed",
    });
    const recovered = await runRecoverRedemption(recoveryClient, store, {
      attemptId: attemptId as string,
      confirm: async () => true,
      verificationDelaysMs: [],
      now: () => OBSERVED_AT_MS + 1_000,
    });
    expect(recovered.envelope.redemption?.state).toBe("completed");
    expect(recoveryClient.consumeCalls).toEqual([
      { idempotencyKey: journaled.idempotencyKey, creditId: "credit-1" },
    ]);
  });

  it("never replays an uncertain attempt after a plan change", async () => {
    const store = new MemoryRedemptionAttemptStore();
    const firstClient = new FakeClient({
      snapshots: stableBefore(4),
      consumeError: new AppServerError("timeout", "timed out", { requestSent: true }),
    });
    const first = await runRedeem(firstClient, store, {
      selector: { kind: "id", id: "credit-1" },
      timeZone: "UTC",
      confirm: async () => true,
      verificationDelaysMs: [],
      now: () => OBSERVED_AT_MS,
    });
    const attemptId = first.envelope.redemption?.attemptId as string;
    let confirmationCalled = false;
    const changedPlan = { ...chatgptAccount, planType: "pro" };
    const recoveryClient = new FakeClient({
      snapshots: [snapshot({ planType: "pro" })],
      accounts: [changedPlan, changedPlan, changedPlan],
    });
    const recovered = await runRecoverRedemption(recoveryClient, store, {
      attemptId,
      confirm: async () => {
        confirmationCalled = true;
        return true;
      },
      verificationDelaysMs: [],
      now: () => OBSERVED_AT_MS + 1_000,
    });
    expect(recovered.exitCode).toBe(EXIT_CODE.authentication);
    expect(recovered.envelope.error?.code).toBe("recovery-plan-mismatch");
    expect(confirmationCalled).toBe(false);
    expect(recoveryClient.consumeCalls).toHaveLength(0);
  });

  it("does not call post-send proof verified when the plan changes", async () => {
    const store = new MemoryRedemptionAttemptStore();
    const changedPlan = { ...chatgptAccount, planType: "pro" };
    const client = new FakeClient({
      snapshots: [...stableBefore(), verifiedAfter()],
      accounts: [chatgptAccount, chatgptAccount, chatgptAccount, changedPlan, changedPlan],
    });
    const execution = await runRedeem(client, store, {
      selector: { kind: "id", id: "credit-1" },
      timeZone: "UTC",
      confirm: async () => true,
      verificationDelaysMs: [],
      now: () => OBSERVED_AT_MS,
    });
    expect(execution.exitCode).toBe(EXIT_CODE.verificationIncomplete);
    expect(execution.envelope.redemption?.state).toBe("completed");
    expect(execution.envelope.verification?.status).toBe("unverified");
    expect(execution.envelope.warnings.join(" ")).toContain("plan no longer matches");
  });

  it("fails closed before preparation when available details are inconsistent", async () => {
    const store = new MemoryRedemptionAttemptStore();
    const client = new FakeClient({
      snapshots: [
        snapshot({
          availableCount: 2,
          credits: [
            resetCredit("history", AUGUST_1_2026_UTC, "redeemed"),
            resetCredit("credit-1", AUGUST_1_2026_UTC),
          ],
        }),
      ],
    });
    const execution = await runPrepareRedemption(client, store, {
      selector: { kind: "earliest" },
      timeZone: "UTC",
      now: () => OBSERVED_AT_MS,
    });
    expect(execution.exitCode).toBe(EXIT_CODE.detailsUnavailable);
    expect(client.consumeCalls).toHaveLength(0);
  });

  it("refuses to prepare a credit whose expiry has already arrived", async () => {
    const store = new MemoryRedemptionAttemptStore();
    const client = new FakeClient({
      snapshots: [
        snapshot({
          availableCount: 1,
          credits: [resetCredit("credit-1", OBSERVED_AT_MS / 1_000)],
        }),
      ],
    });
    const execution = await runPrepareRedemption(client, store, {
      selector: { kind: "id", id: "credit-1" },
      timeZone: "UTC",
      now: () => OBSERVED_AT_MS,
    });
    expect(execution.exitCode).toBe(EXIT_CODE.detailsUnavailable);
    expect(execution.envelope.error?.code).toBe("target-expired");
    expect(client.consumeCalls).toHaveLength(0);
  });

  it("never proves an unknown outcome from a different account snapshot", async () => {
    const store = new MemoryRedemptionAttemptStore();
    const otherAccount = { ...chatgptAccount, email: "other@example.test" };
    const client = new FakeClient({
      snapshots: [...stableBefore(), verifiedAfter()],
      accounts: [chatgptAccount, chatgptAccount, chatgptAccount, otherAccount],
      consumeError: new AppServerError("rpc", "response lost", { requestSent: true }),
    });
    const execution = await runRedeem(client, store, {
      selector: { kind: "id", id: "credit-1" },
      timeZone: "UTC",
      confirm: async () => true,
      verificationDelaysMs: [],
      now: () => OBSERVED_AT_MS,
    });
    expect(execution.exitCode).toBe(EXIT_CODE.outcomeUnknown);
    expect(execution.envelope.redemption?.state).toBe("outcome-unknown");
    expect(execution.envelope.verification?.status).toBe("unverified");
    expect(execution.envelope.warnings.join(" ")).toContain("account no longer matches");
  });

  it("allows read-only proof after the 24-hour replay deadline", async () => {
    const store = new MemoryRedemptionAttemptStore();
    const firstClient = new FakeClient({
      snapshots: stableBefore(4),
      consumeError: new AppServerError("timeout", "timed out", { requestSent: true }),
    });
    const first = await runRedeem(firstClient, store, {
      selector: { kind: "id", id: "credit-2" },
      timeZone: "UTC",
      confirm: async () => true,
      verificationDelaysMs: [],
      now: () => OBSERVED_AT_MS,
    });
    const attemptId = first.envelope.redemption?.attemptId as string;
    const afterCreditTwo = snapshot({
      availableCount: 1,
      credits: [resetCredit("credit-1", AUGUST_1_2026_UTC)],
      usedPercent: 0,
      resetsAt: AUGUST_2_2026_UTC + 604_800,
    });
    const recoveryClient = new FakeClient({ snapshots: [afterCreditTwo] });
    let confirmationCalled = false;
    const recovered = await runRecoverRedemption(recoveryClient, store, {
      attemptId,
      confirm: async () => {
        confirmationCalled = true;
        return true;
      },
      verificationDelaysMs: [],
      now: () => OBSERVED_AT_MS + 25 * 60 * 60 * 1_000,
    });
    expect(recovered.exitCode).toBe(EXIT_CODE.success);
    expect(recovered.envelope.verification?.status).toBe("verified");
    expect(confirmationCalled).toBe(false);
    expect(recoveryClient.consumeCalls).toHaveLength(0);
  });

  it("closes an old unprovable attempt only through a separate local decision", async () => {
    const store = new MemoryRedemptionAttemptStore();
    const firstClient = new FakeClient({
      snapshots: stableBefore(4),
      consumeError: new AppServerError("timeout", "timed out", { requestSent: true }),
    });
    const first = await runRedeem(firstClient, store, {
      selector: { kind: "id", id: "credit-1" },
      timeZone: "UTC",
      confirm: async () => true,
      verificationDelaysMs: [],
      now: () => OBSERVED_AT_MS,
    });
    const attemptId = first.envelope.redemption?.attemptId as string;
    const deniedClient = new FakeClient({ snapshots: [snapshot()] });
    const denied = await runRecoverRedemption(deniedClient, store, {
      attemptId,
      confirm: async () => true,
      verificationDelaysMs: [],
      now: () => OBSERVED_AT_MS + 25 * 60 * 60 * 1_000,
    });
    expect(denied.exitCode).toBe(EXIT_CODE.attempt);
    expect(denied.envelope.redemption?.state).toBe("outcome-unknown");
    expect(deniedClient.consumeCalls).toHaveLength(0);

    const recoveryClient = new FakeClient({ snapshots: [snapshot(), snapshot()] });
    let replayConfirmationCalled = false;
    const closed = await runRecoverRedemption(recoveryClient, store, {
      attemptId,
      confirm: async () => {
        replayConfirmationCalled = true;
        return true;
      },
      confirmCloseUnknown: async () => true,
      verificationDelaysMs: [],
      now: () => OBSERVED_AT_MS + 25 * 60 * 60 * 1_000,
    });
    expect(closed.exitCode).toBe(EXIT_CODE.unknownClosed);
    expect(closed.envelope.redemption?.state).toBe("closed-unknown");
    expect(closed.envelope.redemption?.outcome).toBeNull();
    expect(replayConfirmationCalled).toBe(false);
    expect(recoveryClient.consumeCalls).toHaveLength(0);
  });

  it("does not verify when the wrong card disappears", async () => {
    const store = new MemoryRedemptionAttemptStore();
    const wrongAfter = snapshot({
      availableCount: 1,
      credits: [resetCredit("credit-1", AUGUST_1_2026_UTC)],
      usedPercent: 0,
      resetsAt: AUGUST_2_2026_UTC + 604_800,
    });
    const client = new FakeClient({ snapshots: [...stableBefore(), wrongAfter] });
    const execution = await runRedeem(client, store, {
      selector: { kind: "id", id: "credit-1" },
      timeZone: "UTC",
      confirm: async () => true,
      verificationDelaysMs: [],
      now: () => OBSERVED_AT_MS,
    });
    expect(execution.exitCode).toBe(EXIT_CODE.verificationIncomplete);
    expect(execution.envelope.verification?.targetAvailableAfter).toBe(true);
  });

  it("refuses a second concurrent commit of the same prepared attempt", async () => {
    const store = new MemoryRedemptionAttemptStore();
    const prepareClient = new FakeClient({ snapshots: [snapshot()] });
    const prepared = await runPrepareRedemption(prepareClient, store, {
      selector: { kind: "id", id: "credit-1" },
      timeZone: "UTC",
      now: () => OBSERVED_AT_MS,
    });
    const attemptId = prepared.envelope.redemption?.attemptId as string;
    let releaseConsume!: () => void;
    const consumeBarrier = new Promise<void>((resolve) => {
      releaseConsume = resolve;
    });
    const client = new FakeClient({
      snapshots: [...stableBefore(4), verifiedAfter()],
      onConsume: () => consumeBarrier,
    });
    const first = runCommitRedemption(client, store, {
      attemptId,
      confirm: async () => true,
      verificationDelaysMs: [],
      now: () => OBSERVED_AT_MS,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = runCommitRedemption(client, store, {
      attemptId,
      confirm: async () => true,
      verificationDelaysMs: [],
      now: () => OBSERVED_AT_MS,
    });
    releaseConsume();
    await Promise.all([first, second]);
    expect(client.consumeCalls).toHaveLength(1);
  });

  it("keeps a durable sending record when the post-send journal update fails", async () => {
    const store = new FailingTerminalSaveStore();
    const client = new FakeClient({ snapshots: [...stableBefore(), verifiedAfter()] });
    const execution = await runRedeem(client, store, {
      selector: { kind: "id", id: "credit-1" },
      timeZone: "UTC",
      confirm: async () => true,
      verificationDelaysMs: [],
      now: () => OBSERVED_AT_MS,
    });
    expect(execution.exitCode).toBe(EXIT_CODE.journalIncomplete);
    expect(execution.envelope.warnings.join(" ")).toContain("journal could not record");
    const attemptId = execution.envelope.redemption?.attemptId as string;
    expect((await store.read(attemptId)).state).toBe("sending");
    expect(execution.envelope.redemption?.outcome).toBe("reset");
  });

  it("returns a dedicated recovery result when proven unknown completion cannot be journaled", async () => {
    const store = new FailingTerminalSaveStore();
    const client = new FakeClient({
      snapshots: [...stableBefore(), verifiedAfter()],
      consumeError: new AppServerError("protocol", "future outcome", { requestSent: true }),
    });
    const execution = await runRedeem(client, store, {
      selector: { kind: "id", id: "credit-1" },
      timeZone: "UTC",
      confirm: async () => true,
      verificationDelaysMs: [],
      now: () => OBSERVED_AT_MS,
    });
    expect(execution.exitCode).toBe(EXIT_CODE.journalIncomplete);
    expect(execution.envelope.verification?.status).toBe("verified");
    expect(execution.envelope.warnings.join(" ")).toContain("journal could not record");
    const attemptId = execution.envelope.redemption?.attemptId as string;
    expect((await store.read(attemptId)).state).toBe("sending");
  });
});
