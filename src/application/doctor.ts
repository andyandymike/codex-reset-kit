import type { CodexAppServerClient } from "../app-server/client.js";
import { getPlanType, getReportedPlanTypes } from "../domain/rate-limit.js";
import {
  compatibleAccountError,
  publicAccountFingerprint,
  redemptionAccountError,
} from "./account.js";
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
  envelope.account = publicAccount(account, null, publicAccountFingerprint(account));
  envelope.diagnostics.push({
    name: "account",
    ok: accountError == null,
    message: accountError ?? `Compatible Codex account type: ${String(account.type)}.`,
  });
  if (accountError != null) {
    return fail(envelope, EXIT_CODE.authentication, "incompatible-account", accountError);
  }

  const snapshot = await client.readRateLimits();
  const accountWithPlan = { ...account, planType: account.planType ?? getPlanType(snapshot) };
  envelope.account = publicAccount(
    accountWithPlan,
    getPlanType(snapshot),
    publicAccountFingerprint(accountWithPlan),
  );
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
  const reportedPlans = getReportedPlanTypes(snapshot);
  const planInconsistent = reportedPlans.some((plan) => plan !== accountWithPlan.planType);
  const redemptionError =
    redemptionAccountError(accountWithPlan) ??
    (planInconsistent
      ? "The account and rate-limit buckets report inconsistent ChatGPT plans."
      : null);
  envelope.diagnostics.push({
    name: "redemption-account",
    ok: redemptionError == null,
    message:
      redemptionError ?? "The account is a known personal ChatGPT plan eligible for preparation.",
  });

  if (snapshot.resetCredits.detailsState === "partial") {
    envelope.warnings.push("Precise selection is disabled because the detail list is partial.");
  } else if (snapshot.resetCredits.detailsState === "unavailable") {
    envelope.warnings.push(
      "Precise selection is disabled because individual details are unavailable.",
    );
  } else if (snapshot.resetCredits.detailsState === "inconsistent") {
    envelope.warnings.push(
      "Precise selection is disabled because reset-credit details are inconsistent or unsupported.",
    );
  }

  return succeed(envelope);
}
