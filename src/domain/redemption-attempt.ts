import type { CreditSelector } from "./select-credit.js";

export const REDEMPTION_ATTEMPT_SCHEMA_VERSION = 1;
export const PREPARED_ATTEMPT_TTL_MS = 5 * 60 * 1_000;
export const RECOVERY_ATTEMPT_TTL_MS = 24 * 60 * 60 * 1_000;

export type RedemptionAttemptState =
  | "prepared"
  | "stale"
  | "sending"
  | "outcome-unknown"
  | "closed-unknown"
  | "completed"
  | "rejected";

export interface PreparedResetCredit {
  id: string;
  resetType: "codexRateLimits";
  expiresAt: number;
}

export interface WindowEvidence {
  key: string;
  usedPercent: number | null;
  resetsAt: number | null;
}

export interface RedemptionBaseline {
  observedAt: number;
  availableCount: number;
  windows: WindowEvidence[];
}

export interface RedemptionAttempt {
  schemaVersion: typeof REDEMPTION_ATTEMPT_SCHEMA_VERSION;
  attemptId: string;
  revision: number;
  state: RedemptionAttemptState;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  approvedAt: number | null;
  accountFingerprint: string;
  planType: string | null;
  requestedSelector: CreditSelector;
  target: PreparedResetCredit;
  timeZone: string;
  snapshotDigest: string;
  idempotencyKey: string;
  baseline: RedemptionBaseline;
  outcome: "reset" | "alreadyRedeemed" | "nothingToReset" | "noCredit" | null;
  lastError: string | null;
}

export function isTerminalAttemptState(state: RedemptionAttemptState): boolean {
  return (
    state === "completed" || state === "rejected" || state === "stale" || state === "closed-unknown"
  );
}
