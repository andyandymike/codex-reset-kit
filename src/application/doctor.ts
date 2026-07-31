import type { CodexAppServerClient } from "../app-server/client.js";
import { getPlanType } from "../domain/rate-limit.js";
import { compatibleAccountError } from "./account.js";
import {
  applySnapshot,
  type CommandExecution,
  createEnvelope,
  EXIT_CODE,
  fail,
  publicAccount,
  succeed,
} from "./output.js";

export async function runDoctor(client: CodexAppServerClient): Promise<CommandExecution> {
  const envelope = createEnvelope("doctor");
  envelope.diagnostics.push({
    name: "app-server",
    ok: true,
    message: "The App Server process initialized over JSONL stdio.",
  });

  const account = await client.readAccount();
  const accountError = compatibleAccountError(account);
  envelope.account = publicAccount(account, null);
  envelope.diagnostics.push({
    name: "account",
    ok: accountError == null,
    message: accountError ?? `Compatible Codex account type: ${String(account.type)}.`,
  });
  if (accountError != null) {
    return fail(envelope, EXIT_CODE.authentication, "incompatible-account", accountError);
  }

  const snapshot = await client.readRateLimits();
  envelope.account = publicAccount(account, getPlanType(snapshot));
  applySnapshot(envelope, snapshot);
  envelope.diagnostics.push({
    name: "rate-limits",
    ok: true,
    message: "ChatGPT rate limits were read successfully.",
  });
  envelope.diagnostics.push({
    name: "reset-credit-details",
    ok:
      snapshot.resetCredits.detailsState === "available" ||
      snapshot.resetCredits.detailsState === "empty",
    message: `Reset-credit detail state: ${snapshot.resetCredits.detailsState}.`,
  });

  if (snapshot.resetCredits.detailsState === "partial") {
    envelope.warnings.push("Precise selection is disabled because the detail list is partial.");
  } else if (snapshot.resetCredits.detailsState === "unavailable") {
    envelope.warnings.push(
      "Precise selection is disabled because individual details are unavailable.",
    );
  }

  return succeed(envelope);
}
