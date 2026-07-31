export type ResetCreditDetailsState = "available" | "partial" | "unavailable" | "empty";

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

  const detailsState: ResetCreditDetailsState =
    value.availableCount === 0 && value.credits.length === 0
      ? "empty"
      : value.credits.length < value.availableCount
        ? "partial"
        : "available";

  return {
    availableCount: value.availableCount,
    detailsState,
    credits: value.credits,
    serviceReported: true,
  };
}

export function isAvailableCredit(credit: ResetCredit): boolean {
  return credit.status === "available";
}
