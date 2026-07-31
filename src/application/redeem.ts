import { randomUUID } from "node:crypto";
import type { CodexAppServerClient } from "../app-server/client.js";
import { isAppServerError } from "../app-server/errors.js";
import { getPlanType, type RateLimitSnapshot } from "../domain/rate-limit.js";
import {
  CreditSelectionError,
  type CreditSelector,
  type SelectedCredit,
  selectCredit,
} from "../domain/select-credit.js";
import { type SuccessfulConsumeOutcome, verifyRedemption } from "../domain/verification.js";
import { compatibleAccountError } from "./account.js";
import {
  applySnapshot,
  type CommandEnvelope,
  type CommandExecution,
  createEnvelope,
  EXIT_CODE,
  fail,
  publicAccount,
  publicSnapshot,
  succeed,
} from "./output.js";

export interface RedeemOptions {
  selector: CreditSelector;
  idempotencyKey?: string;
  confirm: (selection: SelectedCredit, before: RateLimitSnapshot) => Promise<boolean>;
  verificationDelaysMs?: number[];
  sleep?: (milliseconds: number) => Promise<void>;
}

const DEFAULT_VERIFICATION_DELAYS_MS = [300, 900];

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function selectionFailure(
  envelope: CommandEnvelope,
  error: CreditSelectionError,
): CommandExecution {
  const exitCode = error.code === "no-credit" ? EXIT_CODE.noCredit : EXIT_CODE.detailsUnavailable;
  return fail(envelope, exitCode, error.code, error.message, error.candidates);
}

function selectForAttempt(
  before: RateLimitSnapshot,
  selector: CreditSelector,
  recoveryKey: string | undefined,
): SelectedCredit {
  if (recoveryKey === undefined) {
    return selectCredit(before, selector);
  }

  if (selector.kind !== "id" && selector.kind !== "next") {
    throw new CreditSelectionError(
      "invalid-selector",
      "Idempotent recovery requires the previously printed --credit-id, or --next when the original request used service selection.",
    );
  }

  try {
    return selectCredit(before, selector);
  } catch (error) {
    if (!(error instanceof CreditSelectionError)) {
      throw error;
    }
    if (!new Set(["no-credit", "details-unavailable", "not-found"]).has(error.code)) {
      throw error;
    }

    return {
      selector,
      creditId: selector.kind === "id" ? selector.id : null,
      credit: null,
      warnings: [
        "Recovery mode cannot re-prove the original credit from the current snapshot; safety relies on reusing the exact idempotency key and original request parameters.",
      ],
    };
  }
}

function setFailedVerification(envelope: CommandEnvelope, before: RateLimitSnapshot): void {
  envelope.verification = {
    status: "failed",
    availableCountDelta: null,
    changedWindows: [],
    notes: [],
    before: publicSnapshot(before),
    after: null,
  };
}

export async function runRedeem(
  client: CodexAppServerClient,
  options: RedeemOptions,
): Promise<CommandExecution> {
  const envelope = createEnvelope("redeem");
  const account = await client.readAccount();
  const accountError = compatibleAccountError(account);
  envelope.account = publicAccount(account, null);
  if (accountError != null) {
    return fail(envelope, EXIT_CODE.authentication, "incompatible-account", accountError);
  }

  const before = await client.readRateLimits();
  envelope.account = publicAccount(account, getPlanType(before));
  applySnapshot(envelope, before);

  let selection: SelectedCredit;
  try {
    selection = selectForAttempt(before, options.selector, options.idempotencyKey);
  } catch (error) {
    if (error instanceof CreditSelectionError) {
      return selectionFailure(envelope, error);
    }
    throw error;
  }

  envelope.warnings.push(...selection.warnings);
  envelope.redemption = {
    requestedSelector: options.selector,
    creditId: selection.creditId,
    selectedCredit: selection.credit,
    idempotencyKey: null,
    outcome: null,
  };

  if (!(await options.confirm(selection, before))) {
    return fail(
      envelope,
      EXIT_CODE.cancelled,
      "confirmation-required",
      "Redemption was cancelled or explicit confirmation was not available.",
    );
  }

  const idempotencyKey = options.idempotencyKey ?? randomUUID();
  envelope.redemption.idempotencyKey = idempotencyKey;

  let outcome: string;
  try {
    outcome = await client.consumeResetCredit({
      idempotencyKey,
      ...(selection.creditId == null ? {} : { creditId: selection.creditId }),
    });
    envelope.redemption.outcome = outcome;
  } catch (error) {
    if (isAppServerError(error) && error.kind === "rpc") {
      setFailedVerification(envelope, before);
      return fail(envelope, EXIT_CODE.rejected, "consume-rejected", error.message);
    }
    if (isAppServerError(error) && error.requestSent) {
      envelope.verification = {
        status: "unverified",
        availableCountDelta: null,
        changedWindows: [],
        notes: ["The consume request may have reached the server; reuse this idempotency key."],
        before: publicSnapshot(before),
        after: null,
      };
      return fail(
        envelope,
        EXIT_CODE.outcomeUnknown,
        "consume-outcome-unknown",
        `The redemption outcome is unknown. Retry only with idempotency key ${idempotencyKey}.`,
      );
    }
    throw error;
  }

  if (outcome === "noCredit") {
    setFailedVerification(envelope, before);
    return fail(
      envelope,
      EXIT_CODE.noCredit,
      "no-credit",
      "The service reports that no earned reset credit is available.",
    );
  }
  if (outcome === "nothingToReset") {
    setFailedVerification(envelope, before);
    return fail(
      envelope,
      EXIT_CODE.nothingToReset,
      "nothing-to-reset",
      "The service reports that no eligible rate-limit window can be reset.",
    );
  }
  if (outcome !== "reset" && outcome !== "alreadyRedeemed") {
    setFailedVerification(envelope, before);
    return fail(
      envelope,
      EXIT_CODE.rejected,
      "unsupported-outcome",
      `The service returned an unsupported consume outcome: ${outcome}.`,
    );
  }

  const delays = options.verificationDelaysMs ?? DEFAULT_VERIFICATION_DELAYS_MS;
  const sleep = options.sleep ?? wait;
  let after: RateLimitSnapshot | null = null;
  let verification = verifyRedemption(outcome as SuccessfulConsumeOutcome, before, null);

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    if (attempt > 0) {
      const delay = delays[attempt - 1];
      if (delay != null) {
        await sleep(delay);
      }
    }
    try {
      after = await client.readRateLimits();
      verification = verifyRedemption(outcome as SuccessfulConsumeOutcome, before, after);
      if (verification.status === "verified") {
        break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      envelope.warnings.push(`Post-consume verification read failed: ${message}`);
    }
  }

  if (after != null) {
    applySnapshot(envelope, after);
  }
  envelope.verification = {
    ...verification,
    before: publicSnapshot(before),
    after: after == null ? null : publicSnapshot(after),
  };

  if (verification.status === "verified") {
    return succeed(envelope);
  }

  return fail(
    envelope,
    EXIT_CODE.verificationIncomplete,
    "verification-incomplete",
    `The service returned ${outcome}, but the reset could not be fully verified from snapshots.`,
  );
}
