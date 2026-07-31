import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type CodexAppServerClient, connectAppServer } from "../../src/app-server/client.js";
import {
  FileRedemptionAttemptStore,
  MemoryRedemptionAttemptStore,
} from "../../src/application/attempt-store.js";
import { EXIT_CODE } from "../../src/application/output.js";
import { runRecoverRedemption, runRedeem } from "../../src/application/redeem.js";
import { OBSERVED_AT_MS } from "../helpers.js";

const fixture = fileURLToPath(new URL("../fixtures/fake-app-server.mjs", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function connect(
  scenario: string,
  options: { timeoutMs?: number; diagnostics?: string[]; ledgerPath?: string } = {},
): Promise<CodexAppServerClient> {
  return connectAppServer({
    command: process.execPath,
    args: [fixture],
    env: {
      ...process.env,
      CODEX_RESET_FAKE_APP_SERVER: "1",
      CODEX_RESET_FAKE_SCENARIO: scenario,
      ...(options.ledgerPath == null ? {} : { CODEX_RESET_FAKE_LEDGER: options.ledgerPath }),
    },
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
        email: "never-forward@example.test",
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
          creditId: "fake-credit-1",
        }),
      ).rejects.toMatchObject({ kind: "timeout", requestSent: true });
    } finally {
      client.close();
    }
  });

  it("fails initialization on an explicit fixture RPC error", async () => {
    await expect(connect("init-fail")).rejects.toMatchObject({ kind: "rpc" });
  });

  it("rejects an incompatible initialize response", async () => {
    await expect(connect("bad-initialize")).rejects.toMatchObject({
      kind: "protocol",
      requestSent: true,
    });
  });

  it("hard-blocks an unmarked real executable while the test suite is running", async () => {
    await expect(
      connectAppServer({ command: "codex", timeoutMs: 1_000, clientVersion: "test" }),
    ).rejects.toThrow(/Test mode blocked/);
  });

  it("does not trust the fake marker without the exact fixture process shape", async () => {
    await expect(
      connectAppServer({
        command: process.execPath,
        args: ["--version"],
        env: { ...process.env, CODEX_RESET_FAKE_APP_SERVER: "1" },
        timeoutMs: 1_000,
        clientVersion: "test",
      }),
    ).rejects.toThrow(/Test mode blocked/);
  });

  it("verifies the full redemption flow against the fake process", async () => {
    const client = await connect("happy");
    try {
      const execution = await runRedeem(client, new MemoryRedemptionAttemptStore(), {
        selector: { kind: "id", id: "fake-credit-1" },
        timeZone: "UTC",
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
      const execution = await runRedeem(client, new MemoryRedemptionAttemptStore(), {
        selector: { kind: "id", id: "fake-credit-1" },
        timeZone: "UTC",
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
        const execution = await runRedeem(client, new MemoryRedemptionAttemptStore(), {
          selector: { kind: "id", id: "fake-credit-1" },
          timeZone: "UTC",
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
      const execution = await runRedeem(client, new MemoryRedemptionAttemptStore(), {
        selector: { kind: "id", id: "fake-credit-1" },
        timeZone: "UTC",
        confirm: async () => true,
        verificationDelaysMs: [],
      });
      expect(execution.exitCode).toBe(EXIT_CODE.verificationIncomplete);
      expect(execution.envelope.verification?.status).toBe("unverified");
    } finally {
      client.close();
    }
  });

  it.each(["rpc-after-consume", "unknown-outcome"])(
    "treats %s after mutation as uncertain, then proves completion read-only",
    async (scenario) => {
      const client = await connect(scenario);
      try {
        const execution = await runRedeem(client, new MemoryRedemptionAttemptStore(), {
          selector: { kind: "id", id: "fake-credit-1" },
          timeZone: "UTC",
          confirm: async () => true,
          verificationDelaysMs: [],
          now: () => OBSERVED_AT_MS,
        });
        expect(execution.exitCode).toBe(0);
        expect(execution.envelope.redemption?.state).toBe("completed");
      } finally {
        client.close();
      }
    },
  );

  it("invalidates preparation when the fake App Server switches accounts", async () => {
    const client = await connect("account-switch");
    try {
      const execution = await runRedeem(client, new MemoryRedemptionAttemptStore(), {
        selector: { kind: "id", id: "fake-credit-1" },
        timeZone: "UTC",
        confirm: async () => true,
        now: () => OBSERVED_AT_MS,
      });
      expect(execution.exitCode).toBe(EXIT_CODE.stale);
      expect(execution.envelope.error?.code).toBe("prepared-state-changed");
    } finally {
      client.close();
    }
  });

  it("recovers across processes with the same journaled key and canonical params", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-reset-cross-process-"));
    temporaryDirectories.push(root);
    const ledgerPath = path.join(root, "fake-ledger.json");
    const store = new FileRedemptionAttemptStore(path.join(root, "state"));

    const firstClient = await connect("timeout-never-update", {
      timeoutMs: 300,
      ledgerPath,
    });
    let first: Awaited<ReturnType<typeof runRedeem>>;
    try {
      first = await runRedeem(firstClient, store, {
        selector: { kind: "id", id: "fake-credit-1" },
        timeZone: "UTC",
        confirm: async () => true,
        verificationDelaysMs: [],
        now: () => OBSERVED_AT_MS,
      });
      expect(first.exitCode).toBe(EXIT_CODE.outcomeUnknown);
    } finally {
      firstClient.close();
    }

    const attemptId = first.envelope.redemption?.attemptId as string;
    const journaled = await store.read(attemptId);
    const secondClient = await connect("never-update", { ledgerPath });
    try {
      const recovered = await runRecoverRedemption(secondClient, store, {
        attemptId,
        confirm: async () => true,
        verificationDelaysMs: [],
        now: () => OBSERVED_AT_MS + 1_000,
      });
      expect(recovered.envelope.redemption?.state).toBe("completed");
      expect(recovered.envelope.redemption?.outcome).toBe("alreadyRedeemed");
    } finally {
      secondClient.close();
    }

    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    expect(Object.keys(ledger)).toEqual([journaled.idempotencyKey]);
    expect(ledger[journaled.idempotencyKey].params).toContain(journaled.target.id);
  });
});
