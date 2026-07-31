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

export async function runList(client: CodexAppServerClient): Promise<CommandExecution> {
  const envelope = createEnvelope("list");
  const account = await client.readAccount();
  const accountError = compatibleAccountError(account);
  envelope.account = publicAccount(account, null);
  if (accountError != null) {
    return fail(envelope, EXIT_CODE.authentication, "incompatible-account", accountError);
  }

  const snapshot = await client.readRateLimits();
  envelope.account = publicAccount(account, getPlanType(snapshot));
  applySnapshot(envelope, snapshot);

  if (!snapshot.resetCredits.serviceReported) {
    envelope.warnings.push("The service did not return earned reset-credit information.");
  } else if (snapshot.resetCredits.detailsState === "unavailable") {
    envelope.warnings.push(
      "Only the authoritative available count is known; individual credit details are unavailable.",
    );
  } else if (snapshot.resetCredits.detailsState === "partial") {
    envelope.warnings.push(
      "The service returned fewer detail rows than the available count; the list is partial.",
    );
  }

  return succeed(envelope);
}
