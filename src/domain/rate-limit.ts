import type { ResetCreditsSnapshot } from "./reset-credit.js";

export interface RateLimitWindow {
  usedPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface RateLimitBucket {
  limitId: string | null;
  limitName: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  planType: string | null;
  rateLimitReachedType: string | null;
}

export interface RateLimitSnapshot {
  rateLimits: RateLimitBucket | null;
  rateLimitsByLimitId: Record<string, RateLimitBucket>;
  resetCredits: ResetCreditsSnapshot;
}

export function getRateLimitBuckets(snapshot: RateLimitSnapshot): Array<[string, RateLimitBucket]> {
  const entries = Object.entries(snapshot.rateLimitsByLimitId);
  if (entries.length > 0) {
    return entries;
  }

  if (snapshot.rateLimits == null) {
    return [];
  }

  return [[snapshot.rateLimits.limitId ?? "default", snapshot.rateLimits]];
}

export function getPlanType(snapshot: RateLimitSnapshot): string | null {
  if (snapshot.rateLimits?.planType != null) {
    return snapshot.rateLimits.planType;
  }

  for (const [, bucket] of getRateLimitBuckets(snapshot)) {
    if (bucket.planType != null) {
      return bucket.planType;
    }
  }

  return null;
}
