import { createHash, randomUUID } from "node:crypto";
import type { AccountSnapshot } from "../app-server/schemas.js";
import {
  getPlanType,
  getRateLimitBuckets,
  getReportedPlanTypes,
  type RateLimitBucket,
  type RateLimitSnapshot,
} from "../domain/rate-limit.js";
import {
  PREPARED_ATTEMPT_TTL_MS,
  REDEMPTION_ATTEMPT_SCHEMA_VERSION,
  type RedemptionAttempt,
  type RedemptionBaseline,
  type WindowEvidence,
} from "../domain/redemption-attempt.js";
import { SUPPORTED_RESET_TYPE } from "../domain/reset-credit.js";
import type { SelectedCredit } from "../domain/select-credit.js";
import { accountFingerprint, redemptionAccountError } from "./account.js";

function sortedWindows(snapshot: RateLimitSnapshot): WindowEvidence[] {
  const windows: WindowEvidence[] = [];
  for (const [bucketId, bucket] of getRateLimitBuckets(snapshot)) {
    if (bucket.primary != null) {
      windows.push({
        key: `${bucketId}:primary`,
        usedPercent: bucket.primary.usedPercent,
        resetsAt: bucket.primary.resetsAt,
      });
    }
    if (bucket.secondary != null) {
      windows.push({
        key: `${bucketId}:secondary`,
        usedPercent: bucket.secondary.usedPercent,
        resetsAt: bucket.secondary.resetsAt,
      });
    }
  }
  return windows.sort((left, right) => left.key.localeCompare(right.key));
}

export function createRedemptionBaseline(
  snapshot: RateLimitSnapshot,
  observedAt: number,
): RedemptionBaseline {
  return {
    observedAt,
    availableCount: snapshot.resetCredits.availableCount,
    windows: sortedWindows(snapshot),
  };
}

export function safetySnapshotDigest(fingerprint: string, snapshot: RateLimitSnapshot): string {
  const availableCredits = snapshot.resetCredits.credits
    .filter((credit) => credit.status === "available")
    .map((credit) => ({
      id: credit.id,
      resetType: credit.resetType,
      expiresAt: credit.expiresAt,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const canonical = JSON.stringify({
    accountFingerprint: fingerprint,
    availableCount: snapshot.resetCredits.availableCount,
    detailsState: snapshot.resetCredits.detailsState,
    availableCredits,
    rateLimits: {
      current: canonicalBucket(snapshot.rateLimits),
      byLimitId: Object.entries(snapshot.rateLimitsByLimitId)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, bucket]) => [id, canonicalBucket(bucket)]),
    },
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function canonicalBucket(bucket: RateLimitBucket | null): unknown {
  if (bucket == null) {
    return null;
  }
  return {
    limitId: bucket.limitId,
    limitName: bucket.limitName,
    planType: bucket.planType,
    rateLimitReachedType: bucket.rateLimitReachedType,
    primary: bucket.primary,
    secondary: bucket.secondary,
  };
}

export function createRedemptionAttempt(
  account: AccountSnapshot,
  snapshot: RateLimitSnapshot,
  selection: SelectedCredit,
  timeZone: string,
  now = Date.now(),
): RedemptionAttempt {
  if (
    selection.credit == null ||
    selection.creditId == null ||
    selection.credit.id !== selection.creditId ||
    selection.credit.resetType !== SUPPORTED_RESET_TYPE ||
    selection.credit.expiresAt == null
  ) {
    throw new Error("A prepared redemption requires one exact, supported credit with an expiry.");
  }
  const targetExpiryMs = selection.credit.expiresAt * 1_000;
  if (targetExpiryMs <= now) {
    throw new Error("An expired reset credit cannot be prepared for redemption.");
  }
  const fingerprint = accountFingerprint(account);
  return {
    schemaVersion: REDEMPTION_ATTEMPT_SCHEMA_VERSION,
    attemptId: randomUUID(),
    revision: 0,
    state: "prepared",
    createdAt: now,
    updatedAt: now,
    expiresAt: Math.min(now + PREPARED_ATTEMPT_TTL_MS, targetExpiryMs),
    approvedAt: null,
    accountFingerprint: fingerprint,
    planType: account.planType,
    requestedSelector: selection.selector,
    target: {
      id: selection.credit.id,
      resetType: SUPPORTED_RESET_TYPE,
      expiresAt: selection.credit.expiresAt,
    },
    timeZone,
    snapshotDigest: safetySnapshotDigest(fingerprint, snapshot),
    idempotencyKey: randomUUID(),
    baseline: createRedemptionBaseline(snapshot, now),
    outcome: null,
    lastError: null,
  };
}

export function confirmationChallenge(attempt: RedemptionAttempt): string {
  return `REDEEM ${attempt.attemptId.slice(0, 8).toUpperCase()}`;
}

export function snapshotStillMatchesAttempt(
  attempt: RedemptionAttempt,
  account: AccountSnapshot,
  snapshot: RateLimitSnapshot,
  now = Date.now(),
): { ok: true } | { ok: false; reason: string } {
  if (now >= attempt.expiresAt) {
    return { ok: false, reason: "The prepared confirmation expired." };
  }
  if (attempt.target.expiresAt * 1_000 <= now) {
    return { ok: false, reason: "The prepared reset credit has expired." };
  }
  let fingerprint: string;
  const accountWithPlan = { ...account, planType: account.planType ?? getPlanType(snapshot) };
  const accountError = redemptionAccountError(accountWithPlan);
  if (accountError != null) {
    return { ok: false, reason: accountError };
  }
  if (getReportedPlanTypes(snapshot).some((plan) => plan !== accountWithPlan.planType)) {
    return {
      ok: false,
      reason:
        "The active ChatGPT plan changed or the rate-limit snapshot reports inconsistent plans.",
    };
  }
  try {
    fingerprint = accountFingerprint(accountWithPlan);
  } catch {
    return { ok: false, reason: "The active account no longer has a stable identity." };
  }
  if (fingerprint !== attempt.accountFingerprint) {
    return { ok: false, reason: "The active ChatGPT account changed after preparation." };
  }
  if (accountWithPlan.planType !== attempt.planType) {
    return { ok: false, reason: "The active ChatGPT plan changed after preparation." };
  }
  if (safetySnapshotDigest(fingerprint, snapshot) !== attempt.snapshotDigest) {
    return {
      ok: false,
      reason: "The reset-credit or rate-limit snapshot changed after preparation.",
    };
  }
  const target = snapshot.resetCredits.credits.find(
    (credit) => credit.id === attempt.target.id && credit.status === "available",
  );
  if (
    target == null ||
    target.resetType !== attempt.target.resetType ||
    target.expiresAt !== attempt.target.expiresAt
  ) {
    return { ok: false, reason: "The prepared reset credit is no longer exactly available." };
  }
  return { ok: true };
}
