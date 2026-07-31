import { getRateLimitBuckets, type RateLimitSnapshot, type RateLimitWindow } from "./rate-limit.js";

export type SuccessfulConsumeOutcome = "reset" | "alreadyRedeemed";
export type VerificationStatus = "verified" | "partial" | "unverified" | "failed";

export interface VerificationResult {
  status: VerificationStatus;
  availableCountDelta: number | null;
  changedWindows: string[];
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

function windowShowsReset(before: RateLimitWindow, after: RateLimitWindow): boolean {
  const usageDropped =
    before.usedPercent != null &&
    after.usedPercent != null &&
    after.usedPercent < before.usedPercent;
  const resetMovedLater =
    before.resetsAt != null && after.resetsAt != null && after.resetsAt > before.resetsAt;
  return usageDropped || resetMovedLater;
}

export function verifyRedemption(
  outcome: SuccessfulConsumeOutcome,
  before: RateLimitSnapshot,
  after: RateLimitSnapshot | null,
): VerificationResult {
  if (after == null) {
    return {
      status: "unverified",
      availableCountDelta: null,
      changedWindows: [],
      notes: ["The consume outcome was successful, but the post-consume snapshot was unavailable."],
    };
  }

  const availableCountDelta =
    before.resetCredits.serviceReported && after.resetCredits.serviceReported
      ? before.resetCredits.availableCount - after.resetCredits.availableCount
      : null;
  const beforeWindows = collectWindows(before);
  const afterWindows = collectWindows(after);
  const changedWindows: string[] = [];

  for (const [key, previous] of beforeWindows) {
    const current = afterWindows.get(key);
    if (current != null && windowShowsReset(previous, current)) {
      changedWindows.push(key);
    }
  }

  if (outcome === "reset" && availableCountDelta === 1 && changedWindows.length > 0) {
    return {
      status: "verified",
      availableCountDelta,
      changedWindows,
      notes: [],
    };
  }

  const notes: string[] = [];
  if (outcome === "alreadyRedeemed") {
    notes.push(
      "The server reported an idempotent replay, so this run may not observe the original delta.",
    );
  }
  if (availableCountDelta == null) {
    notes.push("A reset-credit count was unavailable, so the count delta cannot be verified.");
  } else if (availableCountDelta > 1) {
    notes.push(
      "More than one credit disappeared; expiration or concurrent activity may have occurred.",
    );
  } else if (availableCountDelta <= 0) {
    notes.push("The available credit count did not decrease in the observed snapshots.");
  }
  if (changedWindows.length === 0) {
    notes.push("No eligible rate-limit window showed a clear reset signal yet.");
  }

  const hasAnySignal = (availableCountDelta ?? 0) > 0 || changedWindows.length > 0;
  return {
    status: hasAnySignal ? "partial" : "unverified",
    availableCountDelta,
    changedWindows,
    notes,
  };
}
