import type { RateLimitSnapshot } from "./rate-limit.js";
import { isAvailableCredit, type ResetCredit } from "./reset-credit.js";

export type CreditSelector =
  | { kind: "id"; id: string }
  | { kind: "earliest" }
  | { kind: "expires-on"; date: string; timeZone: string }
  | { kind: "next" };

export type CreditSelectionErrorCode =
  | "no-credit"
  | "details-unavailable"
  | "not-found"
  | "ambiguous"
  | "invalid-selector";

export class CreditSelectionError extends Error {
  readonly code: CreditSelectionErrorCode;
  readonly candidates: ResetCredit[];

  constructor(code: CreditSelectionErrorCode, message: string, candidates: ResetCredit[] = []) {
    super(message);
    this.name = "CreditSelectionError";
    this.code = code;
    this.candidates = candidates;
  }
}

export interface SelectedCredit {
  selector: CreditSelector;
  creditId: string | null;
  credit: ResetCredit | null;
  warnings: string[];
}

export function validateCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match == null) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function validateTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function epochDateInTimeZone(epochSeconds: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(epochSeconds * 1_000));

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function requireCompleteDetails(snapshot: RateLimitSnapshot): ResetCredit[] {
  if (!snapshot.resetCredits.serviceReported) {
    throw new CreditSelectionError(
      "details-unavailable",
      "The service did not report reset-credit availability.",
    );
  }

  if (snapshot.resetCredits.availableCount === 0) {
    throw new CreditSelectionError("no-credit", "No earned reset credits are available.");
  }

  if (snapshot.resetCredits.detailsState !== "available") {
    throw new CreditSelectionError(
      "details-unavailable",
      "Complete reset-credit details are unavailable, so the requested credit cannot be proven.",
    );
  }

  return snapshot.resetCredits.credits;
}

export function selectCredit(
  snapshot: RateLimitSnapshot,
  selector: CreditSelector,
): SelectedCredit {
  if (selector.kind === "next") {
    if (!snapshot.resetCredits.serviceReported) {
      throw new CreditSelectionError(
        "details-unavailable",
        "The service did not report reset-credit availability.",
      );
    }
    if (snapshot.resetCredits.availableCount === 0) {
      throw new CreditSelectionError("no-credit", "No earned reset credits are available.");
    }

    return {
      selector,
      creditId: null,
      credit: null,
      warnings: [
        "The service will choose the credit; this client cannot prove which expiration date will be used.",
      ],
    };
  }

  const credits = requireCompleteDetails(snapshot);
  const available = credits.filter(isAvailableCredit);

  if (selector.kind === "id") {
    const credit = credits.find((candidate) => candidate.id === selector.id);
    if (credit == null) {
      throw new CreditSelectionError(
        "not-found",
        `Reset credit ${selector.id} is not present in the complete current snapshot.`,
      );
    }
    if (!isAvailableCredit(credit)) {
      throw new CreditSelectionError(
        "not-found",
        `Reset credit ${selector.id} is not currently available.`,
      );
    }
    return { selector, creditId: credit.id, credit, warnings: [] };
  }

  if (selector.kind === "earliest") {
    const expiring = available
      .filter((credit) => credit.expiresAt != null)
      .sort((left, right) => (left.expiresAt ?? 0) - (right.expiresAt ?? 0));
    const first = expiring[0];
    if (first?.expiresAt == null) {
      throw new CreditSelectionError(
        "not-found",
        "No available reset credit has a known expiration time.",
      );
    }

    const tied = expiring.filter((credit) => credit.expiresAt === first.expiresAt);
    if (tied.length > 1) {
      throw new CreditSelectionError(
        "ambiguous",
        "Multiple reset credits share the earliest expiration time; choose one by ID.",
        tied,
      );
    }

    return { selector, creditId: first.id, credit: first, warnings: [] };
  }

  if (!validateCalendarDate(selector.date) || !validateTimeZone(selector.timeZone)) {
    throw new CreditSelectionError("invalid-selector", "The date or IANA time zone is invalid.");
  }

  const matches = available.filter(
    (credit) =>
      credit.expiresAt != null &&
      epochDateInTimeZone(credit.expiresAt, selector.timeZone) === selector.date,
  );

  if (matches.length === 0) {
    throw new CreditSelectionError(
      "not-found",
      `No available reset credit expires on ${selector.date} in ${selector.timeZone}.`,
    );
  }
  if (matches.length > 1) {
    throw new CreditSelectionError(
      "ambiguous",
      `Multiple reset credits expire on ${selector.date} in ${selector.timeZone}; choose one by ID.`,
      matches,
    );
  }

  const match = matches[0];
  if (match == null) {
    throw new CreditSelectionError("not-found", "No matching reset credit was found.");
  }
  return { selector, creditId: match.id, credit: match, warnings: [] };
}
