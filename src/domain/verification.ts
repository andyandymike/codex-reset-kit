import { getRateLimitBuckets, type RateLimitSnapshot, type RateLimitWindow } from "./rate-limit.js";
import type { RedemptionAttempt, WindowEvidence } from "./redemption-attempt.js";

export type VerificationStatus = "verified" | "partial" | "unverified" | "failed";

export interface VerificationResult {
  status: VerificationStatus;
  availableCountDelta: number | null;
  targetAvailableAfter: boolean | null;
  changedWindows: string[];
  naturalRolloverPossible: boolean;
  notes: string[];
}

function collectWindows(snapshot: RateLimitSnapshot): Map<string, RateLimitWindow> {
  const windows = new Map<string, RateLimitWindow>();
  for (const [bucketId, bucket] of getRateLimitBuckets(snapshot)) {
    if (bucket.primary != null) {
      windows.set(`${bucketId}:primary`, bucket.primary);
    }
    if (bucket.secondary != null) {
      windows.set(`${bucketId}:secondary`, bucket.secondary);
    }
  }
  return windows;
}

function windowShowsStrongReset(before: WindowEvidence, after: RateLimitWindow): boolean {
  const canCompareUsage = before.usedPercent != null && after.usedPercent != null;
  const canCompareReset = before.resetsAt != null && after.resetsAt != null;
  const usageDropped = canCompareUsage && (after.usedPercent ?? 0) < (before.usedPercent ?? 0);
  const resetMovedLater = canCompareReset && (after.resetsAt ?? 0) > (before.resetsAt ?? 0);
  if (canCompareUsage && canCompareReset) {
    return usageDropped && resetMovedLater;
  }
  return usageDropped || resetMovedLater;
}

function targetAvailability(attempt: RedemptionAttempt, after: RateLimitSnapshot): boolean | null {
  if (
    after.resetCredits.detailsState !== "available" &&
    after.resetCredits.detailsState !== "empty"
  ) {
    return null;
  }
  return after.resetCredits.credits.some(
    (credit) => credit.id === attempt.target.id && credit.status === "available",
  );
}

export function verifyRedemption(
  attempt: RedemptionAttempt,
  after: RateLimitSnapshot | null,
  observedAt = Date.now(),
): VerificationResult {
  if (after == null) {
    return {
      status: "unverified",
      availableCountDelta: null,
      targetAvailableAfter: null,
      changedWindows: [],
      naturalRolloverPossible: false,
      notes: ["The post-consume snapshot was unavailable."],
    };
  }

  const availableCountDelta = after.resetCredits.serviceReported
    ? attempt.baseline.availableCount - after.resetCredits.availableCount
    : null;
  const targetAvailableAfter = targetAvailability(attempt, after);
  const afterWindows = collectWindows(after);
  const changedWindows: string[] = [];
  let naturalRolloverPossible = attempt.target.expiresAt * 1_000 <= observedAt;

  for (const previous of attempt.baseline.windows) {
    const current = afterWindows.get(previous.key);
    if (current == null) {
      continue;
    }
    if (
      previous.resetsAt != null &&
      previous.resetsAt * 1_000 >= attempt.baseline.observedAt &&
      previous.resetsAt * 1_000 <= observedAt
    ) {
      naturalRolloverPossible = true;
      continue;
    }
    if (windowShowsStrongReset(previous, current)) {
      changedWindows.push(previous.key);
    }
  }

  if (
    availableCountDelta === 1 &&
    targetAvailableAfter === false &&
    changedWindows.length > 0 &&
    !naturalRolloverPossible
  ) {
    return {
      status: "verified",
      availableCountDelta,
      targetAvailableAfter,
      changedWindows,
      naturalRolloverPossible,
      notes: [],
    };
  }

  const notes: string[] = [];
  if (targetAvailableAfter === true) {
    notes.push("The exact prepared credit is still available.");
  } else if (targetAvailableAfter == null) {
    notes.push(
      "The post-consume details cannot prove whether the exact prepared credit disappeared.",
    );
  }
  if (availableCountDelta == null) {
    notes.push("The authoritative reset-credit count was unavailable after the request.");
  } else if (availableCountDelta > 1) {
    notes.push(
      "More than one credit disappeared, so concurrent activity or expiry may have occurred.",
    );
  } else if (availableCountDelta <= 0) {
    notes.push("The authoritative available count did not decrease by one.");
  }
  if (changedWindows.length === 0) {
    notes.push("No rate-limit window showed a strong reset signal.");
  }
  if (naturalRolloverPossible) {
    notes.push(
      "A target expiry or natural rate-limit rollover occurred during the observation window.",
    );
  }

  const hasAnySignal =
    targetAvailableAfter === false || (availableCountDelta ?? 0) > 0 || changedWindows.length > 0;
  return {
    status: hasAnySignal ? "partial" : "unverified",
    availableCountDelta,
    targetAvailableAfter,
    changedWindows,
    naturalRolloverPossible,
    notes,
  };
}
