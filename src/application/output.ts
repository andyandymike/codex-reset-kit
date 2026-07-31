import type { AccountSnapshot } from "../app-server/schemas.js";
import type { RateLimitBucket, RateLimitSnapshot } from "../domain/rate-limit.js";
import type { RedemptionAttemptState } from "../domain/redemption-attempt.js";
import type { ResetCredit, ResetCreditDetailsState } from "../domain/reset-credit.js";
import type { CreditSelector } from "../domain/select-credit.js";
import type { VerificationResult, VerificationStatus } from "../domain/verification.js";

export const EXIT_CODE = {
  success: 0,
  arguments: 2,
  authentication: 3,
  detailsUnavailable: 4,
  noCredit: 5,
  nothingToReset: 6,
  cancelled: 7,
  stale: 8,
  attempt: 9,
  rejected: 10,
  verificationIncomplete: 11,
  outcomeUnknown: 12,
  unknownClosed: 13,
  journalIncomplete: 14,
  appServer: 20,
} as const;

export type CommandName = "list" | "doctor" | "prepare" | "redeem" | "commit" | "recover";

export interface PublicAccount {
  type: string | null;
  planType: string | null;
  fingerprint: string | null;
}

export interface PublicRateLimits {
  current: RateLimitBucket | null;
  byLimitId: Record<string, RateLimitBucket>;
}

export interface PublicResetCredit {
  id: string;
  resetType: string | null;
  status: string;
  grantedAt: number | null;
  expiresAt: number | null;
}

export interface PublicResetCredits {
  availableCount: number;
  detailsState: ResetCreditDetailsState;
  credits: PublicResetCredit[];
}

export interface PublicSnapshot {
  rateLimits: PublicRateLimits;
  resetCredits: PublicResetCredits;
}

export interface RedemptionOutput {
  attemptId: string;
  state: RedemptionAttemptState;
  requestedSelector: CreditSelector;
  creditId: string;
  selectedCredit: PublicResetCredit;
  timeZone: string;
  confirmationExpiresAt: number;
  outcome: string | null;
  recoveryCommand: string | null;
}

export interface VerificationOutput extends VerificationResult {
  status: VerificationStatus;
}

export interface DiagnosticCheck {
  name: string;
  ok: boolean;
  message: string;
}

export interface CommandError {
  code: string;
  message: string;
  candidates: PublicResetCredit[];
}

export interface CommandEnvelope {
  schemaVersion: 2;
  command: CommandName;
  ok: boolean;
  account: PublicAccount | null;
  rateLimits: PublicRateLimits | null;
  resetCredits: PublicResetCredits | null;
  redemption: RedemptionOutput | null;
  verification: VerificationOutput | null;
  diagnostics: DiagnosticCheck[];
  warnings: string[];
  error: CommandError | null;
}

export interface CommandExecution {
  exitCode: number;
  envelope: CommandEnvelope;
}

export function publicCredit(credit: ResetCredit): PublicResetCredit {
  return {
    id: credit.id,
    resetType: credit.resetType,
    status: credit.status,
    grantedAt: credit.grantedAt,
    expiresAt: credit.expiresAt,
  };
}

export function createEnvelope(command: CommandName): CommandEnvelope {
  return {
    schemaVersion: 2,
    command,
    ok: false,
    account: null,
    rateLimits: null,
    resetCredits: null,
    redemption: null,
    verification: null,
    diagnostics: [],
    warnings: [],
    error: null,
  };
}

export function publicAccount(
  account: AccountSnapshot,
  fallbackPlanType: string | null,
  fingerprint: string | null = null,
): PublicAccount {
  return {
    type: account.type,
    planType: account.planType ?? fallbackPlanType,
    fingerprint,
  };
}

export function publicSnapshot(
  snapshot: RateLimitSnapshot,
  options: { includeCredits?: boolean } = {},
): PublicSnapshot {
  return {
    rateLimits: {
      current: snapshot.rateLimits,
      byLimitId: snapshot.rateLimitsByLimitId,
    },
    resetCredits: {
      availableCount: snapshot.resetCredits.availableCount,
      detailsState: snapshot.resetCredits.detailsState,
      credits:
        options.includeCredits === false ? [] : snapshot.resetCredits.credits.map(publicCredit),
    },
  };
}

export function applySnapshot(
  envelope: CommandEnvelope,
  snapshot: RateLimitSnapshot,
  options: { includeCredits?: boolean } = {},
): void {
  const view = publicSnapshot(snapshot, options);
  envelope.rateLimits = view.rateLimits;
  envelope.resetCredits = view.resetCredits;
}

export function succeed(envelope: CommandEnvelope): CommandExecution {
  envelope.ok = true;
  envelope.error = null;
  return { exitCode: EXIT_CODE.success, envelope };
}

export function completeWithWarning(
  envelope: CommandEnvelope,
  exitCode: number = EXIT_CODE.verificationIncomplete,
): CommandExecution {
  envelope.ok = true;
  envelope.error = null;
  return { exitCode, envelope };
}

export function fail(
  envelope: CommandEnvelope,
  exitCode: number,
  code: string,
  message: string,
  candidates: ResetCredit[] = [],
): CommandExecution {
  envelope.ok = false;
  envelope.error = { code, message, candidates: candidates.map(publicCredit) };
  return { exitCode, envelope };
}
