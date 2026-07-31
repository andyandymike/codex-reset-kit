import type { AccountSnapshot } from "../app-server/schemas.js";
import type { RateLimitBucket, RateLimitSnapshot } from "../domain/rate-limit.js";
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
  rejected: 10,
  verificationIncomplete: 11,
  outcomeUnknown: 12,
  appServer: 20,
} as const;

export type CommandName = "list" | "doctor" | "redeem";

export interface PublicAccount {
  type: string | null;
  planType: string | null;
}

export interface PublicRateLimits {
  current: RateLimitBucket | null;
  byLimitId: Record<string, RateLimitBucket>;
}

export interface PublicResetCredits {
  availableCount: number;
  detailsState: ResetCreditDetailsState;
  credits: ResetCredit[];
}

export interface PublicSnapshot {
  rateLimits: PublicRateLimits;
  resetCredits: PublicResetCredits;
}

export interface RedemptionOutput {
  requestedSelector: CreditSelector;
  creditId: string | null;
  selectedCredit: ResetCredit | null;
  idempotencyKey: string | null;
  outcome: string | null;
}

export interface VerificationOutput extends VerificationResult {
  status: VerificationStatus;
  before: PublicSnapshot;
  after: PublicSnapshot | null;
}

export interface DiagnosticCheck {
  name: string;
  ok: boolean;
  message: string;
}

export interface CommandError {
  code: string;
  message: string;
  candidates: ResetCredit[];
}

export interface CommandEnvelope {
  schemaVersion: 1;
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

export function createEnvelope(command: CommandName): CommandEnvelope {
  return {
    schemaVersion: 1,
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
): PublicAccount {
  return {
    type: account.type,
    planType: account.planType ?? fallbackPlanType,
  };
}

export function publicSnapshot(snapshot: RateLimitSnapshot): PublicSnapshot {
  return {
    rateLimits: {
      current: snapshot.rateLimits,
      byLimitId: snapshot.rateLimitsByLimitId,
    },
    resetCredits: {
      availableCount: snapshot.resetCredits.availableCount,
      detailsState: snapshot.resetCredits.detailsState,
      credits: snapshot.resetCredits.credits,
    },
  };
}

export function applySnapshot(envelope: CommandEnvelope, snapshot: RateLimitSnapshot): void {
  const view = publicSnapshot(snapshot);
  envelope.rateLimits = view.rateLimits;
  envelope.resetCredits = view.resetCredits;
}

export function succeed(envelope: CommandEnvelope): CommandExecution {
  envelope.ok = true;
  envelope.error = null;
  return { exitCode: EXIT_CODE.success, envelope };
}

export function fail(
  envelope: CommandEnvelope,
  exitCode: number,
  code: string,
  message: string,
  candidates: ResetCredit[] = [],
): CommandExecution {
  envelope.ok = false;
  envelope.error = { code, message, candidates };
  return { exitCode, envelope };
}
