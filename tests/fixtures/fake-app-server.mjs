import { createInterface } from "node:readline";

const scenario = process.env.CODEX_RESET_FAKE_SCENARIO ?? "happy";
const expiresOne = Date.UTC(2026, 7, 1, 0, 0, 0) / 1_000;
const expiresTwo = Date.UTC(2026, 7, 2, 0, 0, 0) / 1_000;
let consumed = false;
let readsAfterConsume = 0;

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

if (scenario === "noisy") {
  process.stdout.write("fake non-json startup line\n");
}

const reader = createInterface({ input: process.stdin });
reader.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialized") {
    return;
  }
  if (message.method === "initialize") {
    if (scenario === "init-fail") {
      send({ id: message.id, error: { code: -32000, message: "fixture init failed" } });
    } else {
      send({
        id: message.id,
        result: { userAgent: "fake-app-server", platformFamily: "test", platformOs: "test" },
      });
    }
    return;
  }
  if (message.method === "account/read") {
    send({
      id: message.id,
      result: {
        account: { type: "chatgpt", planType: "plus", email: "never-forward@example.test" },
        requiresOpenaiAuth: true,
      },
    });
    return;
  }
  if (message.method === "account/rateLimits/read") {
    if (consumed) {
      readsAfterConsume += 1;
    }
    send({ id: message.id, result: snapshot(consumed && scenario !== "never-update") });
    if (scenario === "noisy") {
      send({ method: "account/rateLimits/updated", params: snapshot(consumed) });
    }
    return;
  }
  if (message.method === "account/rateLimitResetCredit/consume") {
    consumed = true;
    if (scenario === "timeout-after-consume") {
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
  send({ id: message.id, error: { code: -32601, message: "unknown fixture method" } });
});

reader.on("close", () => process.exit(0));
