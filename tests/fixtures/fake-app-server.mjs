import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.env.CODEX_RESET_FAKE_APP_SERVER !== "1") {
  throw new Error("The fake App Server requires the explicit test marker.");
}

const scenario = process.env.CODEX_RESET_FAKE_SCENARIO ?? "happy";
const ledgerPath = process.env.CODEX_RESET_FAKE_LEDGER;
const expiresOne = Date.UTC(2026, 7, 1, 0, 0, 0) / 1_000;
const expiresTwo = Date.UTC(2026, 7, 2, 0, 0, 0) / 1_000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function loadLedger() {
  if (ledgerPath == null || !existsSync(ledgerPath)) {
    return {};
  }
  return JSON.parse(readFileSync(ledgerPath, "utf8"));
}

function saveLedger(ledger) {
  if (ledgerPath != null) {
    writeFileSync(ledgerPath, `${JSON.stringify(ledger)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

const ledger = loadLedger();
let initialized = false;
let initializeSeen = false;
let consumed = Object.keys(ledger).length > 0;
let readsAfterConsume = 0;
let accountReads = 0;

const credits = [
  {
    id: "fake-credit-1",
    resetType: "codexRateLimits",
    status: "available",
    grantedAt: expiresOne - 86_400,
    expiresAt: expiresOne,
    title: "Rate-limit reset",
    description: "Fake fixture credit",
  },
  {
    id: "fake-credit-2",
    resetType: "codexRateLimits",
    status: "available",
    grantedAt: expiresOne,
    expiresAt: expiresTwo,
    title: "Rate-limit reset",
    description: "Fake fixture credit",
  },
];

function snapshot(after) {
  const useAfter = after && !(scenario === "delayed" && readsAfterConsume === 1);
  const availableCount = useAfter ? 1 : 2;
  const detailRows = useAfter ? credits.slice(1) : credits;
  return {
    rateLimits: {
      limitId: "codex",
      limitName: "Codex",
      primary: {
        usedPercent: useAfter ? 0 : 98,
        windowDurationMins: 10_080,
        resetsAt: useAfter ? expiresTwo + 604_800 : expiresTwo,
      },
      secondary: null,
      planType: "plus",
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        primary: {
          usedPercent: useAfter ? 0 : 98,
          windowDurationMins: 10_080,
          resetsAt: useAfter ? expiresTwo + 604_800 : expiresTwo,
        },
        secondary: null,
        planType: "plus",
      },
    },
    rateLimitResetCredits: {
      availableCount,
      credits: scenario === "unavailable" ? null : detailRows,
    },
  };
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function rpcError(id, code, message) {
  send({ id, error: { code, message } });
}

if (scenario === "noisy") {
  process.stdout.write("fake non-json startup line\n");
  process.stderr.write("fake diagnostic without account data\n");
}

const reader = createInterface({ input: process.stdin });
reader.on("line", (line) => {
  const message = JSON.parse(line);

  if (message.method === "initialize") {
    if (initializeSeen) {
      rpcError(message.id, -32600, "initialize may only be called once");
      return;
    }
    initializeSeen = true;
    if (scenario === "init-fail") {
      rpcError(message.id, -32000, "fixture init failed");
    } else if (scenario === "bad-initialize") {
      send({ id: message.id, result: {} });
    } else {
      send({
        id: message.id,
        result: { userAgent: "fake-app-server", platformFamily: "test", platformOs: "test" },
      });
    }
    return;
  }

  if (message.method === "initialized") {
    if (!initializeSeen || initialized) {
      process.exitCode = 2;
      reader.close();
      return;
    }
    initialized = true;
    return;
  }

  if (!initialized) {
    rpcError(message.id, -32002, "client is not initialized");
    return;
  }

  if (message.method === "account/read") {
    accountReads += 1;
    const switched = scenario === "account-switch" && accountReads > 1;
    send({
      id: message.id,
      result: {
        account: {
          type: "chatgpt",
          planType: "plus",
          email: switched ? "switched@example.test" : "never-forward@example.test",
        },
        requiresOpenaiAuth: true,
      },
    });
    if (switched) {
      send({ method: "account/updated", params: {} });
    }
    return;
  }

  if (message.method === "account/rateLimits/read") {
    if (consumed) {
      readsAfterConsume += 1;
    }
    send({
      id: message.id,
      result: snapshot(
        consumed && scenario !== "never-update" && scenario !== "timeout-never-update",
      ),
    });
    if (scenario === "noisy") {
      send({ method: "account/rateLimits/updated", params: snapshot(consumed) });
    }
    return;
  }

  if (message.method === "account/rateLimitResetCredit/consume") {
    const params = message.params;
    if (
      params == null ||
      typeof params !== "object" ||
      !uuidPattern.test(params.idempotencyKey ?? "") ||
      params.creditId !== "fake-credit-1"
    ) {
      rpcError(message.id, -32602, "consume requires the exact fake credit and a UUID key");
      return;
    }

    const canonicalParams = JSON.stringify({
      idempotencyKey: params.idempotencyKey,
      creditId: params.creditId,
    });
    const existing = ledger[params.idempotencyKey];
    if (existing != null) {
      if (existing.params !== canonicalParams) {
        rpcError(message.id, -32602, "an idempotency key cannot be reused with different params");
      } else {
        send({ id: message.id, result: { outcome: "alreadyRedeemed" } });
      }
      return;
    }

    ledger[params.idempotencyKey] = { params: canonicalParams };
    saveLedger(ledger);
    consumed = true;
    if (scenario === "timeout-after-consume" || scenario === "timeout-never-update") {
      return;
    }
    if (scenario === "rpc-after-consume") {
      rpcError(message.id, -32603, "fixture internal timeout after commit");
      return;
    }
    if (scenario === "unknown-outcome") {
      send({ id: message.id, result: { outcome: "futureSuccess" } });
      return;
    }

    const outcome =
      scenario === "already"
        ? "alreadyRedeemed"
        : scenario === "no-credit"
          ? "noCredit"
          : scenario === "nothing"
            ? "nothingToReset"
            : "reset";
    send({ id: message.id, result: { outcome } });
    return;
  }

  rpcError(message.id, -32601, "unknown fixture method");
});

reader.on("close", () => process.exit(process.exitCode ?? 0));
