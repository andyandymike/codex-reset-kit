import { describe, expect, it } from "vitest";
import type { CodexAppServerClient, ConsumeResetParams } from "../../src/app-server/client.js";
import { AppServerError } from "../../src/app-server/errors.js";
import type { AccountSnapshot, ConsumeResetOutcome } from "../../src/app-server/schemas.js";
import { MemoryRedemptionAttemptStore } from "../../src/application/attempt-store.js";
import type { RateLimitSnapshot } from "../../src/domain/rate-limit.js";
import {
  RESET_MCP_TOOLS,
  type ResetMcpCallContext,
  ResetMcpToolService,
} from "../../src/mcp/tool-service.js";
import {
  AUGUST_1_2026_UTC,
  AUGUST_2_2026_UTC,
  chatgptAccount,
  OBSERVED_AT_MS,
  resetCredit,
  snapshot,
} from "../helpers.js";

interface SharedServiceState {
  consumed: boolean;
  consumeCalls: ConsumeResetParams[];
  firstConsumeUnknown?: boolean;
}

class SharedFakeClient implements CodexAppServerClient {
  readonly #state: SharedServiceState;

  constructor(state: SharedServiceState) {
    this.#state = state;
  }

  async readAccount(): Promise<AccountSnapshot> {
    return chatgptAccount;
  }

  async readRateLimits(): Promise<RateLimitSnapshot> {
    return this.#state.consumed
      ? snapshot({
          availableCount: 1,
          credits: [resetCredit("credit-2", AUGUST_2_2026_UTC)],
          usedPercent: 0,
          resetsAt: AUGUST_2_2026_UTC + 604_800,
        })
      : snapshot();
  }

  async consumeResetCredit(params: ConsumeResetParams): Promise<ConsumeResetOutcome> {
    this.#state.consumeCalls.push(params);
    if (this.#state.firstConsumeUnknown === true && this.#state.consumeCalls.length === 1) {
      throw new AppServerError("timeout", "simulated unknown send", { requestSent: true });
    }
    this.#state.consumed = true;
    return "reset";
  }

  getAccountEpoch(): number {
    return 0;
  }

  close(): void {}
}

function context(confirm: boolean): ResetMcpCallContext {
  return {
    signal: new AbortController().signal,
    clientCapabilities: { protocolVersion: "2025-11-25", formElicitation: true },
    requestConfirmation: async () => confirm,
  };
}

function approvalFrom(result: {
  structuredContent: Record<string, unknown>;
}): Record<string, unknown> {
  const approval = result.structuredContent.approval;
  if (approval == null || typeof approval !== "object") {
    throw new Error("MCP result did not include an approval binding");
  }
  return approval as Record<string, unknown>;
}

function createService(state: SharedServiceState) {
  return new ResetMcpToolService({
    connect: async () => new SharedFakeClient(state),
    store: new MemoryRedemptionAttemptStore(),
    now: () => OBSERVED_AT_MS,
    verificationDelaysMs: [],
  });
}

describe("remote MCP reset tools", () => {
  it("advertises accurate destructive and read-only annotations", () => {
    expect(
      RESET_MCP_TOOLS.find((tool) => tool.name === "check_remote_reset_setup")?.annotations,
    ).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    });
    expect(RESET_MCP_TOOLS.find((tool) => tool.name === "list_reset_credits")?.annotations).toEqual(
      {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
    );
    expect(
      RESET_MCP_TOOLS.find((tool) => tool.name === "redeem_prepared_reset")?.annotations,
    ).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
      idempotentHint: true,
    });
    expect(
      RESET_MCP_TOOLS.find((tool) => tool.name === "recover_reset_redemption")?.annotations
        .destructiveHint,
    ).toBe(true);
  });

  it("checks Remote readiness without preparing or consuming a credit", async () => {
    const state: SharedServiceState = { consumed: false, consumeCalls: [] };
    const service = createService(state);
    const readOnlyContext = context(false);
    readOnlyContext.requestConfirmation = async () => {
      throw new Error("The read-only setup check must not request confirmation.");
    };
    const result = await service.call(
      "check_remote_reset_setup",
      { time_zone: "UTC" },
      readOnlyContext,
    );

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.readiness).toMatchObject({
      ready: true,
      hostReady: true,
      protocolVersion: "2025-11-25",
      formElicitation: true,
      journal: { ready: true, state: "injected" },
    });
    expect(result.content[0]?.text).toContain("No reset attempt was prepared");
    expect(state.consumeCalls).toHaveLength(0);
  });

  it("reports setup as not ready when local journal storage fails inspection", async () => {
    const state: SharedServiceState = { consumed: false, consumeCalls: [] };
    const service = new ResetMcpToolService({
      connect: async () => new SharedFakeClient(state),
      store: new MemoryRedemptionAttemptStore(),
      inspectStateDirectory: async () => ({
        ready: false,
        state: "invalid",
        message: "simulated inaccessible journal",
      }),
      now: () => OBSERVED_AT_MS,
    });

    const result = await service.call("check_remote_reset_setup", {}, context(false));

    expect(result.structuredContent.readiness).toMatchObject({
      ready: false,
      hostReady: false,
      journal: { ready: false, state: "invalid" },
    });
    expect(state.consumeCalls).toHaveLength(0);
  });

  it("reports setup as not ready when the MCP client cannot show the bound form", async () => {
    const state: SharedServiceState = { consumed: false, consumeCalls: [] };
    const service = createService(state);
    const unavailable = context(false);
    unavailable.clientCapabilities.formElicitation = false;

    const result = await service.call("check_remote_reset_setup", {}, unavailable);

    expect(result.structuredContent.readiness).toMatchObject({
      ready: false,
      hostReady: true,
      formElicitation: false,
    });
    expect(state.consumeCalls).toHaveLength(0);
  });

  it("requires an explicit timezone for a calendar-date selector", async () => {
    const state: SharedServiceState = { consumed: false, consumeCalls: [] };
    const service = createService(state);
    const result = await service.call(
      "prepare_reset_redemption",
      { expires_on: "2026-08-01" },
      context(false),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("time_zone is required");
    expect(state.consumeCalls).toHaveLength(0);
  });

  it("prepares an exact binding without consuming", async () => {
    const state: SharedServiceState = { consumed: false, consumeCalls: [] };
    const service = createService(state);
    const result = await service.call(
      "prepare_reset_redemption",
      { expires_on: "2026-08-01", time_zone: "UTC" },
      context(false),
    );
    expect(result.isError).toBeUndefined();
    expect(approvalFrom(result)).toMatchObject({
      account_fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
      credit_id: "credit-1",
      expires_at: AUGUST_1_2026_UTC,
    });
    expect(state.consumeCalls).toHaveLength(0);
    expect(result.content[0]?.text).toContain("Nothing was consumed");
  });

  it("does not consume when the bound in-client confirmation is declined", async () => {
    const state: SharedServiceState = { consumed: false, consumeCalls: [] };
    const service = createService(state);
    const prepared = await service.call(
      "prepare_reset_redemption",
      { credit_id: "credit-1", time_zone: "UTC" },
      context(false),
    );
    const result = await service.call(
      "redeem_prepared_reset",
      approvalFrom(prepared),
      context(false),
    );
    expect(state.consumeCalls).toHaveLength(0);
    expect(result.content[0]?.text).toContain("required user confirmation");
  });

  it("rejects any changed approval field before opening a consume path", async () => {
    const state: SharedServiceState = { consumed: false, consumeCalls: [] };
    const service = createService(state);
    const prepared = await service.call(
      "prepare_reset_redemption",
      { credit_id: "credit-1", time_zone: "UTC" },
      context(false),
    );
    const binding = approvalFrom(prepared);
    const result = await service.call(
      "redeem_prepared_reset",
      { ...binding, credit_id: "credit-2" },
      context(true),
    );
    expect(state.consumeCalls).toHaveLength(0);
    expect(result.content[0]?.text).toContain("do not exactly match");
  });

  it("consumes once only after the exact remote confirmation and verifies the result", async () => {
    const state: SharedServiceState = { consumed: false, consumeCalls: [] };
    const service = createService(state);
    const prepared = await service.call(
      "prepare_reset_redemption",
      { credit_id: "credit-1", time_zone: "UTC" },
      context(false),
    );
    const confirmations: string[] = [];
    const result = await service.call("redeem_prepared_reset", approvalFrom(prepared), {
      signal: new AbortController().signal,
      clientCapabilities: { protocolVersion: "2025-11-25", formElicitation: true },
      requestConfirmation: async (request) => {
        confirmations.push(request.message);
        return true;
      },
    });
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]).toContain("irreversible");
    expect(confirmations[0]).toContain("Credit ID: credit-1");
    expect(state.consumeCalls).toHaveLength(1);
    expect(state.consumeCalls[0]?.creditId).toBe("credit-1");
    expect(result.content[0]?.text).toContain("Verification: verified");

    const repeated = await service.call(
      "redeem_prepared_reset",
      approvalFrom(prepared),
      context(true),
    );
    expect(state.consumeCalls).toHaveLength(1);
    expect(repeated.content[0]?.text).toContain("only a prepared attempt can be committed");
  });

  it("shows an identity digest for a maximum-length credit ID before confirmation", async () => {
    const creditId = `${"x".repeat(1_023)}z`;
    const state: SharedServiceState = { consumed: false, consumeCalls: [] };
    const service = new ResetMcpToolService({
      connect: async () =>
        new (class extends SharedFakeClient {
          override async readRateLimits(): Promise<RateLimitSnapshot> {
            return snapshot({ credits: [resetCredit(creditId, AUGUST_1_2026_UTC)] });
          }
        })(state),
      store: new MemoryRedemptionAttemptStore(),
      now: () => OBSERVED_AT_MS,
      verificationDelaysMs: [],
    });
    const prepared = await service.call(
      "prepare_reset_redemption",
      { credit_id: creditId, time_zone: "UTC" },
      context(false),
    );
    const confirmations: string[] = [];

    await service.call("redeem_prepared_reset", approvalFrom(prepared), {
      ...context(false),
      requestConfirmation: async (request) => {
        confirmations.push(request.message);
        return false;
      },
    });

    expect(confirmations[0]).toContain(`${"x".repeat(31)}z`);
    expect(confirmations[0]).toMatch(/sha256 [0-9a-f]{64}/);
    expect(state.consumeCalls).toHaveLength(0);
  });

  it("recovers an unknown send with the same exact idempotency key", async () => {
    const state: SharedServiceState = {
      consumed: false,
      consumeCalls: [],
      firstConsumeUnknown: true,
    };
    const service = createService(state);
    const prepared = await service.call(
      "prepare_reset_redemption",
      { credit_id: "credit-1", time_zone: "UTC" },
      context(false),
    );
    const binding = approvalFrom(prepared);
    const unknown = await service.call("redeem_prepared_reset", binding, context(true));
    expect(unknown.content[0]?.text).toContain("result is unknown");
    expect(state.consumeCalls).toHaveLength(1);

    const recovered = await service.call("recover_reset_redemption", binding, context(true));
    expect(state.consumeCalls).toHaveLength(2);
    expect(state.consumeCalls[1]).toEqual(state.consumeCalls[0]);
    expect(recovered.content[0]?.text).toContain("Verification: verified");
  });
});
