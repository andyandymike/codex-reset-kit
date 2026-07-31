export const SUPPORTED_RESET_TYPE = "codexRateLimits";

export type ResetCreditDetailsState =
  | "available"
  | "partial"
  | "inconsistent"
  | "unavailable"
  | "empty";

export interface ResetCredit {
  id: string;
  resetType: string | null;
  status: string;
  grantedAt: number | null;
  expiresAt: number | null;
  title: string | null;
  description: string | null;
}

export interface ResetCreditsSnapshot {
  availableCount: number;
  detailsState: ResetCreditDetailsState;
  credits: ResetCredit[];
  serviceReported: boolean;
}

export interface RawResetCredits {
  availableCount: number;
  credits?: ResetCredit[] | null;
}

export function createResetCreditsSnapshot(
  value: RawResetCredits | null | undefined,
): ResetCreditsSnapshot {
  if (value == null) {
    return {
      availableCount: 0,
      detailsState: "unavailable",
      credits: [],
      serviceReported: false,
    };
  }

  if (value.credits == null) {
    return {
      availableCount: value.availableCount,
      detailsState: "unavailable",
      credits: [],
      serviceReported: true,
    };
  }

  const ids = value.credits.map((credit) => credit.id);
  const hasDuplicateId = new Set(ids).size !== ids.length;
  const hasUnknownStatus = value.credits.some(
    (credit) => !new Set(["available", "redeeming", "redeemed"]).has(credit.status),
  );
  const statusAvailable = value.credits.filter((credit) => credit.status === "available");
  const hasUnsupportedAvailableType = statusAvailable.some(
    (credit) => credit.resetType !== SUPPORTED_RESET_TYPE,
  );

  let detailsState: ResetCreditDetailsState;
  if (hasDuplicateId || hasUnknownStatus || hasUnsupportedAvailableType) {
    detailsState = "inconsistent";
  } else if (statusAvailable.length < value.availableCount) {
    detailsState = "partial";
  } else if (statusAvailable.length > value.availableCount) {
    detailsState = "inconsistent";
  } else if (value.availableCount === 0) {
    detailsState = "empty";
  } else {
    detailsState = "available";
  }

  return {
    availableCount: value.availableCount,
    detailsState,
    credits: value.credits,
    serviceReported: true,
  };
}

export function isAvailableCredit(credit: ResetCredit): boolean {
  return credit.status === "available" && credit.resetType === SUPPORTED_RESET_TYPE;
}
