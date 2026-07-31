import { z } from "zod";
import type { RateLimitBucket, RateLimitSnapshot, RateLimitWindow } from "../domain/rate-limit.js";
import {
  createResetCreditsSnapshot,
  type RawResetCredits,
  type ResetCredit,
} from "../domain/reset-credit.js";

const rateLimitWindowSchema = z
  .object({
    usedPercent: z.number().finite().optional().nullable(),
    windowDurationMins: z.number().finite().optional().nullable(),
    resetsAt: z.number().int().optional().nullable(),
  })
  .passthrough();

const rateLimitBucketSchema = z
  .object({
    limitId: z.string().optional().nullable(),
    limitName: z.string().optional().nullable(),
    primary: rateLimitWindowSchema.optional().nullable(),
    secondary: rateLimitWindowSchema.optional().nullable(),
    planType: z.string().optional().nullable(),
    rateLimitReachedType: z.string().optional().nullable(),
  })
  .passthrough();

const resetCreditSchema = z
  .object({
    id: z.string().min(1),
    resetType: z.string().optional().nullable(),
    status: z.string().min(1),
    grantedAt: z.number().int().optional().nullable(),
    expiresAt: z.number().int().optional().nullable(),
    title: z.string().optional().nullable(),
    description: z.string().optional().nullable(),
  })
  .passthrough();

const resetCreditsSchema = z
  .object({
    availableCount: z.number().int().nonnegative(),
    credits: z.array(resetCreditSchema).optional().nullable(),
  })
  .passthrough();

export const rateLimitsReadResultSchema = z
  .object({
    rateLimits: rateLimitBucketSchema.optional().nullable(),
    rateLimitsByLimitId: z.record(z.string(), rateLimitBucketSchema).optional(),
    rateLimitResetCredits: resetCreditsSchema.optional().nullable(),
  })
  .passthrough();

export const accountReadResultSchema = z
  .object({
    account: z
      .object({
        type: z.string(),
        planType: z.string().optional().nullable(),
      })
      .passthrough()
      .optional()
      .nullable(),
    requiresOpenaiAuth: z.boolean().optional(),
  })
  .passthrough();

export const consumeResetResultSchema = z
  .object({
    outcome: z.string().min(1),
  })
  .passthrough();

export interface AccountSnapshot {
  type: string | null;
  planType: string | null;
  requiresOpenaiAuth: boolean;
}

function normalizeWindow(
  value: z.infer<typeof rateLimitWindowSchema> | null | undefined,
): RateLimitWindow | null {
  if (value == null) {
    return null;
  }
  return {
    usedPercent: value.usedPercent ?? null,
    windowDurationMins: value.windowDurationMins ?? null,
    resetsAt: value.resetsAt ?? null,
  };
}

function normalizeBucket(value: z.infer<typeof rateLimitBucketSchema>): RateLimitBucket {
  return {
    limitId: value.limitId ?? null,
    limitName: value.limitName ?? null,
    primary: normalizeWindow(value.primary),
    secondary: normalizeWindow(value.secondary),
    planType: value.planType ?? null,
    rateLimitReachedType: value.rateLimitReachedType ?? null,
  };
}

function normalizeCredit(value: z.infer<typeof resetCreditSchema>): ResetCredit {
  return {
    id: value.id,
    resetType: value.resetType ?? null,
    status: value.status,
    grantedAt: value.grantedAt ?? null,
    expiresAt: value.expiresAt ?? null,
    title: value.title ?? null,
    description: value.description ?? null,
  };
}

export function parseAccountSnapshot(value: unknown): AccountSnapshot {
  const parsed = accountReadResultSchema.parse(value);
  return {
    type: parsed.account?.type ?? null,
    planType: parsed.account?.planType ?? null,
    requiresOpenaiAuth: parsed.requiresOpenaiAuth ?? true,
  };
}

export function parseRateLimitSnapshot(value: unknown): RateLimitSnapshot {
  const parsed = rateLimitsReadResultSchema.parse(value);
  const byId = Object.fromEntries(
    Object.entries(parsed.rateLimitsByLimitId ?? {}).map(([id, bucket]) => [
      id,
      normalizeBucket(bucket),
    ]),
  );
  let rawResetCredits: RawResetCredits | null | undefined;
  if (parsed.rateLimitResetCredits == null) {
    rawResetCredits = parsed.rateLimitResetCredits;
  } else if (parsed.rateLimitResetCredits.credits === undefined) {
    rawResetCredits = { availableCount: parsed.rateLimitResetCredits.availableCount };
  } else {
    rawResetCredits = {
      availableCount: parsed.rateLimitResetCredits.availableCount,
      credits:
        parsed.rateLimitResetCredits.credits == null
          ? null
          : parsed.rateLimitResetCredits.credits.map(normalizeCredit),
    };
  }

  return {
    rateLimits: parsed.rateLimits == null ? null : normalizeBucket(parsed.rateLimits),
    rateLimitsByLimitId: byId,
    resetCredits: createResetCreditsSnapshot(rawResetCredits),
  };
}

export function parseConsumeOutcome(value: unknown): string {
  return consumeResetResultSchema.parse(value).outcome;
}
