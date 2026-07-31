import type { CodexAppServerClient } from "../app-server/client.js";
import { isAppServerError } from "../app-server/errors.js";
import type { AccountSnapshot, ConsumeResetOutcome } from "../app-server/schemas.js";
import { getPlanType, getReportedPlanTypes, type RateLimitSnapshot } from "../domain/rate-limit.js";
import { RECOVERY_ATTEMPT_TTL_MS, type RedemptionAttempt } from "../domain/redemption-attempt.js";
import { SUPPORTED_RESET_TYPE } from "../domain/reset-credit.js";
import {
  CreditSelectionError,
  type CreditSelector,
  type SelectedCredit,
  selectCredit,
} from "../domain/select-credit.js";
import { type VerificationResult, verifyRedemption } from "../domain/verification.js";
import { redactText, safeTerminalField } from "../security/redact.js";
import {
  accountFingerprint,
  publicAccountFingerprint,
  redemptionAccountError,
  redemptionIdentityError,
} from "./account.js";
import { AttemptStoreError, type RedemptionAttemptStore } from "./attempt-store.js";
import {
  applySnapshot,
  type CommandEnvelope,
  type CommandExecution,
  completeWithWarning,
  createEnvelope,
  EXIT_CODE,
  fail,
  publicAccount,
  succeed,
} from "./output.js";
import { createRedemptionAttempt, snapshotStillMatchesAttempt } from "./redemption-intent.js";

export interface PrepareRedemptionOptions {
  selector: CreditSelector;
  timeZone: string;
  now?: () => number;
}

export interface CommitRedemptionOptions {
  attemptId: string;
  confirm: (
    attempt: Readonly<RedemptionAttempt>,
    account: Readonly<AccountSnapshot>,
    snapshot: Readonly<RateLimitSnapshot>,
  ) => Promise<boolean>;
  verificationDelaysMs?: number[];
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export interface RecoverRedemptionOptions {
  attemptId: string;
  confirm: (
    attempt: Readonly<RedemptionAttempt>,
    account: Readonly<AccountSnapshot>,
  ) => Promise<boolean>;
  confirmCloseUnknown?: (
    attempt: Readonly<RedemptionAttempt>,
    account: Readonly<AccountSnapshot>,
    verification: Readonly<VerificationResult>,
  ) => Promise<boolean>;
  verificationDelaysMs?: number[];
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export interface RedeemOptions
  extends PrepareRedemptionOptions,
    Omit<CommitRedemptionOptions, "attemptId"> {}

const DEFAULT_VERIFICATION_DELAYS_MS = [0, 500, 1_500, 3_000];

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function frozenClone<T>(value: T): Readonly<T> {
  const clone = structuredClone(value);
  const freeze = (candidate: unknown): void => {
    if (candidate == null || typeof candidate !== "object" || Object.isFrozen(candidate)) {
      return;
    }
    for (const child of Object.values(candidate)) {
      freeze(child);
    }
    Object.freeze(candidate);
  };
  freeze(clone);
  return clone;
}

function selectionFailure(
  envelope: CommandEnvelope,
  error: CreditSelectionError,
): CommandExecution {
  const exitCode = error.code === "no-credit" ? EXIT_CODE.noCredit : EXIT_CODE.detailsUnavailable;
  return fail(envelope, exitCode, error.code, error.message, error.candidates);
}

class ReconciliationBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconciliationBindingError";
  }
}

function accountMatchesAttempt(account: AccountSnapshot, attempt: RedemptionAttempt): boolean {
  if (redemptionIdentityError(account) != null) {
    return false;
  }
  try {
    return accountFingerprint(account) === attempt.accountFingerprint;
  } catch {
    return false;
  }
}

async function readAccountBoundRateLimits(
  client: CodexAppServerClient,
  attempt: RedemptionAttempt,
): Promise<RateLimitSnapshot> {
  const epochBefore = client.getAccountEpoch();
  const accountBefore = await client.readAccount();
  if (!accountMatchesAttempt(accountBefore, attempt)) {
    throw new ReconciliationBindingError(
      "Read-only reconciliation stopped because the active ChatGPT account no longer matches the journal.",
    );
  }
  const snapshot = await client.readRateLimits();
  const accountAfter = await client.readAccount();
  if (client.getAccountEpoch() !== epochBefore || !accountMatchesAttempt(accountAfter, attempt)) {
    throw new ReconciliationBindingError(
      "Read-only reconciliation stopped because the active ChatGPT account changed during the proof read.",
    );
  }
  const observedPlans = [
    accountBefore.planType,
    ...getReportedPlanTypes(snapshot),
    accountAfter.planType,
  ].filter((plan): plan is string => plan != null);
  if (
    observedPlans.length === 0 ||
    observedPlans.some((plan) => plan !== attempt.planType) ||
    redemptionAccountError({ ...accountAfter, planType: observedPlans[0] ?? null }) != null
  ) {
    throw new ReconciliationBindingError(
      "Read-only reconciliation stopped because the active ChatGPT plan no longer matches the journal.",
    );
  }
  return snapshot;
}

function applyAttempt(envelope: CommandEnvelope, attempt: RedemptionAttempt): void {
  const targetCompleted =
    attempt.state === "completed" ||
    attempt.outcome === "reset" ||
    attempt.outcome === "alreadyRedeemed";
  envelope.redemption = {
    attemptId: attempt.attemptId,
    state: attempt.state,
    requestedSelector: attempt.requestedSelector,
    creditId: attempt.target.id,
    selectedCredit: {
      id: attempt.target.id,
      resetType: attempt.target.resetType,
      status:
        attempt.state === "closed-unknown" ? "unknown" : targetCompleted ? "redeemed" : "available",
      grantedAt: null,
      expiresAt: attempt.target.expiresAt,
    },
    timeZone: attempt.timeZone,
    confirmationExpiresAt: Math.floor(attempt.expiresAt / 1_000),
    outcome: attempt.outcome,
    recoveryCommand:
      attempt.state === "sending" || attempt.state === "outcome-unknown"
        ? `codex-reset recover --attempt ${attempt.attemptId}`
        : null,
  };
}

function attemptFailure(command: "commit" | "recover", error: unknown): CommandExecution {
  const envelope = createEnvelope(command);
  if (error instanceof AttemptStoreError) {
    const exitCode =
      error.code === "locked" || error.code === "conflict" ? EXIT_CODE.stale : EXIT_CODE.attempt;
    return fail(envelope, exitCode, `attempt-${error.code}`, error.message);
  }
  throw error;
}

async function saveState(
  store: RedemptionAttemptStore,
  attempt: RedemptionAttempt,
  state: RedemptionAttempt["state"],
  changes: Partial<Pick<RedemptionAttempt, "approvedAt" | "outcome" | "lastError">> = {},
): Promise<RedemptionAttempt> {
  return store.save({ ...attempt, state, ...changes });
}

async function readVerification(
  client: CodexAppServerClient,
  attempt: RedemptionAttempt,
  options: {
    verificationDelaysMs?: number[] | undefined;
    sleep?: ((milliseconds: number) => Promise<void>) | undefined;
    now: () => number;
  },
): Promise<{
  after: RateLimitSnapshot | null;
  verification: VerificationResult;
  warnings: string[];
  bindingError: string | null;
}> {
  const delays = options.verificationDelaysMs ?? DEFAULT_VERIFICATION_DELAYS_MS;
  const sleep = options.sleep ?? wait;
  let after: RateLimitSnapshot | null = null;
  let verification = verifyRedemption(attempt, null, options.now());
  const warnings: string[] = [];
  let bindingError: string | null = null;

  for (let index = 0; index <= delays.length; index += 1) {
    if (index > 0) {
      const delay = delays[index - 1];
      if (delay != null && delay > 0) {
        await sleep(delay);
      }
    }
    try {
      after = await readAccountBoundRateLimits(client, attempt);
      verification = verifyRedemption(attempt, after, options.now());
      if (verification.status === "verified") {
        break;
      }
    } catch (error) {
      warnings.push(
        `A read-only reconciliation failed: ${redactText(error instanceof Error ? error.message : String(error))}`,
      );
      if (error instanceof ReconciliationBindingError) {
        bindingError = error.message;
        break;
      }
    }
  }
  return { after, verification, warnings, bindingError };
}

async function finalizeKnownOutcome(
  client: CodexAppServerClient,
  store: RedemptionAttemptStore,
  envelope: CommandEnvelope,
  attempt: RedemptionAttempt,
  outcome: ConsumeResetOutcome,
  options: {
    verificationDelaysMs?: number[] | undefined;
    sleep?: ((milliseconds: number) => Promise<void>) | undefined;
    now: () => number;
  },
): Promise<CommandExecution> {
  if (outcome === "noCredit" || outcome === "nothingToReset") {
    attempt = await saveState(store, attempt, "rejected", { outcome, lastError: null });
    applyAttempt(envelope, attempt);
    envelope.verification = {
      status: "failed",
      availableCountDelta: null,
      targetAvailableAfter: null,
      changedWindows: [],
      naturalRolloverPossible: false,
      notes: [],
    };
    return fail(
      envelope,
      outcome === "noCredit" ? EXIT_CODE.noCredit : EXIT_CODE.nothingToReset,
      outcome === "noCredit" ? "no-credit" : "nothing-to-reset",
      outcome === "noCredit"
        ? "The service reports that no earned reset credit is available."
        : "The service reports that no eligible rate-limit window can be reset.",
    );
  }

  attempt = await saveState(store, attempt, "completed", { outcome, lastError: null });
  const reconciliation = await readVerification(client, attempt, options);
  envelope.warnings.push(...reconciliation.warnings);
  envelope.verification = reconciliation.verification;
  if (reconciliation.after != null) {
    applySnapshot(envelope, reconciliation.after, { includeCredits: false });
  }
  applyAttempt(envelope, attempt);
  if (outcome === "alreadyRedeemed") {
    envelope.warnings.push(
      "The service reports that this exact journaled attempt completed previously. Do not create a new attempt.",
    );
  }
  return reconciliation.verification.status === "verified"
    ? succeed(envelope)
    : completeWithWarning(envelope);
}

async function finalizeUnknownOutcome(
  client: CodexAppServerClient,
  store: RedemptionAttemptStore,
  envelope: CommandEnvelope,
  attempt: RedemptionAttempt,
  error: unknown,
  options: {
    verificationDelaysMs?: number[] | undefined;
    sleep?: ((milliseconds: number) => Promise<void>) | undefined;
    now: () => number;
  },
): Promise<CommandExecution> {
  const message = safeTerminalField(error instanceof Error ? error.message : String(error), 4_096);
  try {
    attempt = await saveState(store, attempt, "outcome-unknown", {
      outcome: null,
      lastError: message,
    });
  } catch (journalError) {
    envelope.warnings.push(
      `The consume result is unknown and the durable journal could not be advanced: ${redactText(
        journalError instanceof Error ? journalError.message : String(journalError),
      )}`,
    );
  }
  const reconciliation = await readVerification(client, attempt, options);
  envelope.warnings.push(...reconciliation.warnings);
  envelope.verification = reconciliation.verification;
  if (reconciliation.after != null) {
    applySnapshot(envelope, reconciliation.after, { includeCredits: false });
  }

  if (reconciliation.verification.status === "verified") {
    try {
      attempt = await saveState(store, attempt, "completed", { lastError: message });
    } catch (journalError) {
      envelope.warnings.push(
        `Completion was proven, but the journal could not record it: ${safeTerminalField(
          journalError instanceof Error ? journalError.message : String(journalError),
          1_024,
        )}`,
      );
      envelope.warnings.push(
        `Do not create a new attempt. Finalize only with: codex-reset recover --attempt ${attempt.attemptId}`,
      );
      applyAttempt(envelope, attempt);
      return completeWithWarning(envelope, EXIT_CODE.journalIncomplete);
    }
    applyAttempt(envelope, attempt);
    envelope.warnings.push(
      "The consume response was unknown, but exact target and rate-limit evidence prove completion. Do not retry.",
    );
    return succeed(envelope);
  }

  applyAttempt(envelope, attempt);
  return fail(
    envelope,
    EXIT_CODE.outcomeUnknown,
    "consume-outcome-unknown",
    `The result is unknown. Do not create a new attempt. Use: codex-reset recover --attempt ${attempt.attemptId}`,
  );
}

async function finalizeAfterJournalFailure(
  client: CodexAppServerClient,
  envelope: CommandEnvelope,
  attempt: RedemptionAttempt,
  outcome: ConsumeResetOutcome,
  journalError: unknown,
  options: {
    verificationDelaysMs?: number[] | undefined;
    sleep?: ((milliseconds: number) => Promise<void>) | undefined;
    now: () => number;
  },
): Promise<CommandExecution> {
  const transientAttempt: RedemptionAttempt = { ...attempt, outcome };
  const reconciliation = await readVerification(client, transientAttempt, options);
  envelope.warnings.push(...reconciliation.warnings);
  envelope.warnings.push(
    `The server response was received, but the journal could not record it: ${redactText(
      journalError instanceof Error ? journalError.message : String(journalError),
    )}`,
  );
  envelope.warnings.push(
    `Do not create a new attempt. The durable sending record can only be handled with: codex-reset recover --attempt ${attempt.attemptId}`,
  );
  envelope.verification = reconciliation.verification;
  if (reconciliation.after != null) {
    applySnapshot(envelope, reconciliation.after, { includeCredits: false });
  }
  applyAttempt(envelope, transientAttempt);
  if (outcome === "reset" || outcome === "alreadyRedeemed") {
    return completeWithWarning(envelope, EXIT_CODE.journalIncomplete);
  }
  return fail(
    envelope,
    outcome === "noCredit" ? EXIT_CODE.noCredit : EXIT_CODE.nothingToReset,
    outcome === "noCredit" ? "no-credit" : "nothing-to-reset",
    "The service returned a definitive non-consuming outcome, but the local journal update failed.",
  );
}

export async function runPrepareRedemption(
  client: CodexAppServerClient,
  store: RedemptionAttemptStore,
  options: PrepareRedemptionOptions,
): Promise<CommandExecution> {
  const envelope = createEnvelope("prepare");
  const account = await client.readAccount();
  const accountError = redemptionIdentityError(account);
  envelope.account = publicAccount(account, null, publicAccountFingerprint(account));
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
  applySnapshot(envelope, snapshot, { includeCredits: false });
  const planError = redemptionAccountError(accountWithPlan);
  if (planError != null) {
    return fail(envelope, EXIT_CODE.authentication, "incompatible-account", planError);
  }
  if (getReportedPlanTypes(snapshot).some((plan) => plan !== accountWithPlan.planType)) {
    return fail(
      envelope,
      EXIT_CODE.authentication,
      "inconsistent-plan",
      "The account and rate-limit buckets report inconsistent ChatGPT plans, so redemption is disabled.",
    );
  }

  let selection: SelectedCredit;
  try {
    selection = selectCredit(snapshot, options.selector);
  } catch (error) {
    if (error instanceof CreditSelectionError) {
      return selectionFailure(envelope, error);
    }
    throw error;
  }
  if (
    selection.credit == null ||
    selection.creditId == null ||
    selection.credit.resetType !== SUPPORTED_RESET_TYPE ||
    selection.credit.expiresAt == null
  ) {
    return fail(
      envelope,
      EXIT_CODE.detailsUnavailable,
      "unprovable-target",
      "The exact credit type and expiration must be known before redemption can be prepared.",
    );
  }

  const observedAt = (options.now ?? Date.now)();
  if (selection.credit.expiresAt * 1_000 <= observedAt) {
    return fail(
      envelope,
      EXIT_CODE.detailsUnavailable,
      "target-expired",
      "The selected reset credit has already expired and cannot be prepared.",
    );
  }

  const attempt = createRedemptionAttempt(
    accountWithPlan,
    snapshot,
    selection,
    options.timeZone,
    observedAt,
  );
  await store.create(attempt);
  applyAttempt(envelope, attempt);
  envelope.warnings.push(
    `Nothing was consumed. This preparation expires within five minutes and before the target credit expires; confirmation must happen in a local interactive terminal.`,
  );
  return succeed(envelope);
}

export async function runCommitRedemption(
  client: CodexAppServerClient,
  store: RedemptionAttemptStore,
  options: CommitRedemptionOptions,
): Promise<CommandExecution> {
  const envelope = createEnvelope("commit");
  const now = options.now ?? Date.now;
  let attempt: RedemptionAttempt;
  try {
    attempt = await store.read(options.attemptId);
  } catch (error) {
    return attemptFailure("commit", error);
  }
  applyAttempt(envelope, attempt);
  if (attempt.state !== "prepared") {
    return fail(
      envelope,
      EXIT_CODE.attempt,
      "attempt-not-prepared",
      `Attempt ${attempt.attemptId} is ${attempt.state}; only a prepared attempt can be committed.`,
    );
  }

  const account = await client.readAccount();
  const snapshot = await client.readRateLimits();
  envelope.account = publicAccount(
    account,
    getPlanType(snapshot),
    publicAccountFingerprint(account),
  );
  applySnapshot(envelope, snapshot, { includeCredits: false });
  const initialMatch = snapshotStillMatchesAttempt(attempt, account, snapshot, now());
  if (!initialMatch.ok) {
    attempt = await saveState(store, attempt, "stale", { lastError: initialMatch.reason });
    applyAttempt(envelope, attempt);
    return fail(envelope, EXIT_CODE.stale, "prepared-state-changed", initialMatch.reason);
  }

  const epochBeforeConfirmation = client.getAccountEpoch();
  if (!(await options.confirm(frozenClone(attempt), frozenClone(account), frozenClone(snapshot)))) {
    attempt = await saveState(store, attempt, "stale", {
      lastError: "Local confirmation was cancelled.",
    });
    applyAttempt(envelope, attempt);
    return fail(
      envelope,
      EXIT_CODE.cancelled,
      "confirmation-required",
      "Redemption was cancelled or a local interactive confirmation was unavailable.",
    );
  }

  try {
    return await store.withAccountLock(attempt.accountFingerprint, attempt.attemptId, async () => {
      attempt = await store.read(attempt.attemptId);
      if (attempt.state !== "prepared") {
        throw new AttemptStoreError("conflict", "The prepared attempt changed before commit.");
      }
      const latestAccount = await client.readAccount();
      const latestSnapshot = await client.readRateLimits();
      envelope.account = publicAccount(
        latestAccount,
        getPlanType(latestSnapshot),
        publicAccountFingerprint(latestAccount),
      );
      applySnapshot(envelope, latestSnapshot, { includeCredits: false });
      if (client.getAccountEpoch() !== epochBeforeConfirmation) {
        attempt = await saveState(store, attempt, "stale", {
          lastError: "The App Server reported an account change during confirmation.",
        });
        applyAttempt(envelope, attempt);
        return fail(
          envelope,
          EXIT_CODE.stale,
          "account-changed",
          "The App Server reported an account change during confirmation.",
        );
      }
      const latestMatch = snapshotStillMatchesAttempt(
        attempt,
        latestAccount,
        latestSnapshot,
        now(),
      );
      if (!latestMatch.ok) {
        attempt = await saveState(store, attempt, "stale", { lastError: latestMatch.reason });
        applyAttempt(envelope, attempt);
        return fail(envelope, EXIT_CODE.stale, "prepared-state-changed", latestMatch.reason);
      }

      attempt = await saveState(store, attempt, "sending", {
        approvedAt: now(),
        lastError: null,
      });
      applyAttempt(envelope, attempt);
      let outcome: ConsumeResetOutcome;
      try {
        outcome = await client.consumeResetCredit({
          idempotencyKey: attempt.idempotencyKey,
          creditId: attempt.target.id,
        });
      } catch (error) {
        if (isAppServerError(error) && !error.requestSent) {
          attempt = await saveState(store, attempt, "prepared", {
            approvedAt: null,
            lastError: safeTerminalField(error.message, 4_096),
          });
          applyAttempt(envelope, attempt);
          return fail(
            envelope,
            EXIT_CODE.appServer,
            `app-server-${error.kind}`,
            "The consume request was not sent. Re-run commit and confirm again.",
          );
        }
        return await finalizeUnknownOutcome(client, store, envelope, attempt, error, {
          verificationDelaysMs: options.verificationDelaysMs,
          sleep: options.sleep,
          now,
        });
      }
      try {
        return await finalizeKnownOutcome(client, store, envelope, attempt, outcome, {
          verificationDelaysMs: options.verificationDelaysMs,
          sleep: options.sleep,
          now,
        });
      } catch (journalError) {
        return finalizeAfterJournalFailure(client, envelope, attempt, outcome, journalError, {
          verificationDelaysMs: options.verificationDelaysMs,
          sleep: options.sleep,
          now,
        });
      }
    });
  } catch (error) {
    return attemptFailure("commit", error);
  }
}

export async function runRecoverRedemption(
  client: CodexAppServerClient,
  store: RedemptionAttemptStore,
  options: RecoverRedemptionOptions,
): Promise<CommandExecution> {
  const envelope = createEnvelope("recover");
  const now = options.now ?? Date.now;
  let attempt: RedemptionAttempt;
  try {
    attempt = await store.read(options.attemptId);
  } catch (error) {
    return attemptFailure("recover", error);
  }
  applyAttempt(envelope, attempt);

  if (attempt.state === "completed") {
    envelope.warnings.push("This attempt is already completed. No consume request was sent.");
    return completeWithWarning(envelope);
  }
  if (attempt.state !== "sending" && attempt.state !== "outcome-unknown") {
    return fail(
      envelope,
      EXIT_CODE.attempt,
      "attempt-not-recoverable",
      `Attempt ${attempt.attemptId} is ${attempt.state}; recovery is only allowed after an uncertain send.`,
    );
  }
  const account = await client.readAccount();
  const accountError = redemptionIdentityError(account);
  envelope.account = publicAccount(account, null, publicAccountFingerprint(account));
  if (accountError != null || accountFingerprint(account) !== attempt.accountFingerprint) {
    return fail(
      envelope,
      EXIT_CODE.authentication,
      "recovery-account-mismatch",
      accountError ?? "The active ChatGPT account does not match the journaled attempt.",
    );
  }

  const beforeReplay = await readVerification(client, attempt, {
    verificationDelaysMs: [],
    now,
  });
  envelope.verification = beforeReplay.verification;
  envelope.warnings.push(...beforeReplay.warnings);
  if (beforeReplay.verification.status === "verified") {
    attempt = await saveState(store, attempt, "completed", {
      lastError: "Completion was proven by read-only recovery.",
    });
    applyAttempt(envelope, attempt);
    envelope.warnings.push(
      "Read-only reconciliation proved completion. No consume request was sent.",
    );
    return succeed(envelope);
  }

  if (now() - attempt.createdAt >= RECOVERY_ATTEMPT_TTL_MS) {
    const epochBeforeClosure = client.getAccountEpoch();
    if (
      options.confirmCloseUnknown == null ||
      !(await options.confirmCloseUnknown(
        frozenClone(attempt),
        frozenClone(account),
        frozenClone(beforeReplay.verification),
      ))
    ) {
      return fail(
        envelope,
        EXIT_CODE.attempt,
        "recovery-expired",
        "Read-only reconciliation could not prove this attempt, and it is at least 24 hours old. Replay is disabled; closing the unknown result requires a separate local confirmation.",
      );
    }

    try {
      return await store.withAccountLock(
        attempt.accountFingerprint,
        attempt.attemptId,
        async () => {
          attempt = await store.read(attempt.attemptId);
          if (attempt.state !== "sending" && attempt.state !== "outcome-unknown") {
            throw new AttemptStoreError("conflict", "The attempt changed before unknown closure.");
          }
          const latestAccount = await client.readAccount();
          if (
            !accountMatchesAttempt(latestAccount, attempt) ||
            client.getAccountEpoch() !== epochBeforeClosure
          ) {
            return fail(
              envelope,
              EXIT_CODE.authentication,
              "recovery-account-mismatch",
              "The active ChatGPT account changed before the unknown attempt could be closed.",
            );
          }
          const finalReadOnlyCheck = await readVerification(client, attempt, {
            verificationDelaysMs: [],
            now,
          });
          envelope.verification = finalReadOnlyCheck.verification;
          envelope.warnings.push(...finalReadOnlyCheck.warnings);
          const closingAccount = await client.readAccount();
          if (
            !accountMatchesAttempt(closingAccount, attempt) ||
            client.getAccountEpoch() !== epochBeforeClosure
          ) {
            return fail(
              envelope,
              EXIT_CODE.authentication,
              "recovery-account-mismatch",
              "The active ChatGPT account changed during the final read-only closure check.",
            );
          }
          if (finalReadOnlyCheck.verification.status === "verified") {
            attempt = await saveState(store, attempt, "completed", {
              lastError: "Completion was proven before unknown closure.",
            });
            applyAttempt(envelope, attempt);
            envelope.warnings.push(
              "The final read-only check proved completion. The unknown attempt was not closed and no request was sent.",
            );
            return succeed(envelope);
          }
          attempt = await saveState(store, attempt, "closed-unknown", {
            outcome: null,
            lastError:
              "The user deliberately closed an unprovable attempt after the replay deadline.",
          });
          applyAttempt(envelope, attempt);
          envelope.warnings.push(
            "The old outcome remains unknown. Same-key replay is permanently disabled, no request was sent, and future attempts may proceed only because you explicitly closed this journal.",
          );
          return completeWithWarning(envelope, EXIT_CODE.unknownClosed);
        },
      );
    } catch (error) {
      return attemptFailure("recover", error);
    }
  }

  const epochBeforeConfirmation = client.getAccountEpoch();
  if (beforeReplay.bindingError != null) {
    return fail(
      envelope,
      EXIT_CODE.authentication,
      "recovery-plan-mismatch",
      beforeReplay.bindingError,
    );
  }
  if (!(await options.confirm(frozenClone(attempt), frozenClone(account)))) {
    return fail(
      envelope,
      EXIT_CODE.cancelled,
      "recovery-confirmation-required",
      "Recovery was cancelled. No consume request was sent.",
    );
  }
  try {
    return await store.withAccountLock(attempt.accountFingerprint, attempt.attemptId, async () => {
      attempt = await store.read(attempt.attemptId);
      if (attempt.state !== "sending" && attempt.state !== "outcome-unknown") {
        throw new AttemptStoreError("conflict", "The attempt changed before recovery.");
      }
      const latestAccount = await client.readAccount();
      if (
        redemptionAccountError(latestAccount) != null ||
        accountFingerprint(latestAccount) !== attempt.accountFingerprint ||
        client.getAccountEpoch() !== epochBeforeConfirmation
      ) {
        return fail(
          envelope,
          EXIT_CODE.authentication,
          "recovery-account-mismatch",
          "The active ChatGPT account changed before recovery could replay the exact request.",
        );
      }
      const finalReadOnlyCheck = await readVerification(client, attempt, {
        verificationDelaysMs: [],
        now,
      });
      if (finalReadOnlyCheck.bindingError != null) {
        envelope.verification = finalReadOnlyCheck.verification;
        envelope.warnings.push(...finalReadOnlyCheck.warnings);
        return fail(
          envelope,
          EXIT_CODE.authentication,
          "recovery-plan-mismatch",
          finalReadOnlyCheck.bindingError,
        );
      }
      if (finalReadOnlyCheck.verification.status === "verified") {
        attempt = await saveState(store, attempt, "completed", {
          lastError: "Completion was proven immediately before recovery replay.",
        });
        envelope.verification = finalReadOnlyCheck.verification;
        applyAttempt(envelope, attempt);
        envelope.warnings.push(
          "A final read-only check proved completion. No consume request was sent.",
        );
        return succeed(envelope);
      }
      attempt = await saveState(store, attempt, "sending", { lastError: null });
      applyAttempt(envelope, attempt);
      let outcome: ConsumeResetOutcome;
      try {
        outcome = await client.consumeResetCredit({
          idempotencyKey: attempt.idempotencyKey,
          creditId: attempt.target.id,
        });
      } catch (error) {
        return await finalizeUnknownOutcome(client, store, envelope, attempt, error, {
          verificationDelaysMs: options.verificationDelaysMs,
          sleep: options.sleep,
          now,
        });
      }
      try {
        return await finalizeKnownOutcome(client, store, envelope, attempt, outcome, {
          verificationDelaysMs: options.verificationDelaysMs,
          sleep: options.sleep,
          now,
        });
      } catch (journalError) {
        return finalizeAfterJournalFailure(client, envelope, attempt, outcome, journalError, {
          verificationDelaysMs: options.verificationDelaysMs,
          sleep: options.sleep,
          now,
        });
      }
    });
  } catch (error) {
    return attemptFailure("recover", error);
  }
}

export async function runRedeem(
  client: CodexAppServerClient,
  store: RedemptionAttemptStore,
  options: RedeemOptions,
): Promise<CommandExecution> {
  const prepared = await runPrepareRedemption(client, store, options);
  const attemptId = prepared.envelope.redemption?.attemptId;
  if (prepared.exitCode !== EXIT_CODE.success || attemptId == null) {
    prepared.envelope.command = "redeem";
    return prepared;
  }
  const committed = await runCommitRedemption(client, store, {
    attemptId,
    confirm: options.confirm,
    ...(options.verificationDelaysMs === undefined
      ? {}
      : { verificationDelaysMs: options.verificationDelaysMs }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  committed.envelope.command = "redeem";
  return committed;
}
