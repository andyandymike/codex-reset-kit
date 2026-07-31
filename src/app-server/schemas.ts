import { z } from "zod";
import type { RateLimitBucket, RateLimitSnapshot, RateLimitWindow } from "../domain/rate-limit.js";
import {
  createResetCreditsSnapshot,
  type RawResetCredits,
  type ResetCredit,
} from "../domain/reset-credit.js";
import { hasControlCharacters } from "../security/redact.js";

const protocolString = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => !hasControlCharacters(value), {
    message: "Protocol strings must not contain control characters.",
  });

const protocolLabel = protocolString.max(256);
const epochSeconds = z.number().int().min(0).max(253_402_300_799);

const rateLimitWindowSchema = z.object({
  usedPercent: z.number().finite().min(0).max(100).optional().nullable(),
  windowDurationMins: z.number().finite().positive().max(5_256_000).optional().nullable(),
  resetsAt: epochSeconds.optional().nullable(),
});

const rateLimitBucketSchema = z.object({
  limitId: protocolLabel.optional().nullable(),
  limitName: protocolLabel.optional().nullable(),
  primary: rateLimitWindowSchema.optional().nullable(),
  secondary: rateLimitWindowSchema.optional().nullable(),
  planType: protocolLabel.optional().nullable(),
  rateLimitReachedType: protocolLabel.optional().nullable(),
});

const resetCreditSchema = z.object({
  id: protocolString.max(1_024),
  resetType: protocolLabel.optional().nullable(),
  status: protocolLabel,
  grantedAt: epochSeconds.optional().nullable(),
  expiresAt: epochSeconds.optional().nullable(),
  title: protocolString.optional().nullable(),
  description: protocolString.optional().nullable(),
});

const resetCreditsSchema = z.object({
  availableCount: z.number().int().nonnegative().max(1_000_000),
  credits: z.array(resetCreditSchema).max(1_024).optional().nullable(),
});

const rateLimitsByLimitIdSchema = z
  .record(protocolLabel, rateLimitBucketSchema)
  .refine((value) => Object.keys(value).length <= 1_024, {
    message: "Too many rate-limit buckets were returned.",
  });

export const rateLimitsReadResultSchema = z.object({
  rateLimits: rateLimitBucketSchema.optional().nullable(),
  rateLimitsByLimitId: rateLimitsByLimitIdSchema.optional(),
  rateLimitResetCredits: resetCreditsSchema.optional().nullable(),
});

export const accountReadResultSchema = z.object({
  account: z
    .object({
      type: protocolLabel,
      planType: protocolLabel.optional().nullable(),
      email: protocolString.max(320).optional().nullable(),
    })
    .optional()
    .nullable(),
  requiresOpenaiAuth: z.boolean().optional(),
});

export const initializeResultSchema = z.object({
  userAgent: protocolString.max(512),
  platformFamily: protocolLabel.optional().nullable(),
  platformOs: protocolLabel.optional().nullable(),
});

export const consumeResetResultSchema = z.object({
  outcome: z.enum(["reset", "alreadyRedeemed", "nothingToReset", "noCredit"]),
});

export type ConsumeResetOutcome = z.infer<typeof consumeResetResultSchema>["outcome"];

export interface InitializeSnapshot {
  userAgent: string;
  platformFamily: string | null;
  platformOs: string | null;
}

export interface AccountSnapshot {
  type: string | null;
  planType: string | null;
  email: string | null;
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
    email: parsed.account?.email ?? null,
    requiresOpenaiAuth: parsed.requiresOpenaiAuth ?? true,
  };
}

export function parseInitializeSnapshot(value: unknown): InitializeSnapshot {
  const parsed = initializeResultSchema.parse(value);
  return {
    userAgent: parsed.userAgent,
    platformFamily: parsed.platformFamily ?? null,
    platformOs: parsed.platformOs ?? null,
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

export function parseConsumeOutcome(value: unknown): ConsumeResetOutcome {
  return consumeResetResultSchema.parse(value).outcome;
}
