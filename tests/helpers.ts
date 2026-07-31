import { parseRateLimitSnapshot } from "../src/app-server/schemas.js";
import type { RateLimitSnapshot } from "../src/domain/rate-limit.js";
import type { ResetCredit } from "../src/domain/reset-credit.js";

export const AUGUST_1_2026_UTC = Date.UTC(2026, 7, 1, 0, 0, 0) / 1_000;
export const AUGUST_2_2026_UTC = Date.UTC(2026, 7, 2, 0, 0, 0) / 1_000;

export function resetCredit(
  id: string,
  expiresAt: number | null,
  status = "available",
): ResetCredit {
  return {
    id,
    resetType: "codexRateLimits",
    status,
    grantedAt: AUGUST_1_2026_UTC - 86_400,
    expiresAt,
    title: "Rate-limit reset",
    description: "Reset an eligible Codex rate-limit window.",
  };
}

export interface SnapshotOptions {
  availableCount?: number;
  credits?: ResetCredit[] | null;
  usedPercent?: number;
  resetsAt?: number;
}

export function snapshot(options: SnapshotOptions = {}): RateLimitSnapshot {
  const credits =
    options.credits === undefined
      ? [resetCredit("credit-1", AUGUST_1_2026_UTC), resetCredit("credit-2", AUGUST_2_2026_UTC)]
      : options.credits;
  return parseRateLimitSnapshot({
    rateLimits: {
      limitId: "codex",
      limitName: "Codex",
      primary: {
        usedPercent: options.usedPercent ?? 98,
        windowDurationMins: 10_080,
        resetsAt: options.resetsAt ?? AUGUST_2_2026_UTC,
      },
      secondary: null,
      planType: "plus",
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        primary: {
          usedPercent: options.usedPercent ?? 98,
          windowDurationMins: 10_080,
          resetsAt: options.resetsAt ?? AUGUST_2_2026_UTC,
        },
        secondary: null,
        planType: "plus",
      },
    },
    rateLimitResetCredits: {
      availableCount: options.availableCount ?? credits?.length ?? 0,
      credits,
    },
  });
}
