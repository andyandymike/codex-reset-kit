import { createHash } from "node:crypto";
import type { AccountSnapshot } from "../app-server/schemas.js";

const SUPPORTED_PERSONAL_PLANS = new Set(["free", "go", "plus", "pro", "prolite"]);
const WORKSPACE_PLANS = new Set([
  "team",
  "self_serve_business_usage_based",
  "business",
  "ent26",
  "enterprise_cbp_usage_based",
  "enterprise",
  "hc",
  "education",
  "edu",
]);

export function compatibleAccountError(account: AccountSnapshot): string | null {
  if (account.type == null) {
    return account.requiresOpenaiAuth
      ? "Codex is not signed in. Sign in with ChatGPT through Codex first."
      : "The active Codex provider does not expose ChatGPT rate limits.";
  }
  if (account.type !== "chatgpt") {
    return `The active Codex account type (${account.type}) cannot use ChatGPT reset credits.`;
  }
  return null;
}

export function redemptionIdentityError(account: AccountSnapshot): string | null {
  const compatibilityError = compatibleAccountError(account);
  if (compatibilityError != null) {
    return compatibilityError;
  }
  if (account.email == null || account.email.trim().length === 0) {
    return "The active ChatGPT account has no stable identity field, so redemption cannot be safely bound to it.";
  }
  return null;
}

export function redemptionPlanError(planType: string | null): string | null {
  const plan = planType?.trim().toLowerCase();
  if (plan == null || plan.length === 0) {
    return "The active ChatGPT plan could not be identified, so redemption is disabled.";
  }
  if (SUPPORTED_PERSONAL_PLANS.has(plan)) {
    return null;
  }
  if (WORKSPACE_PLANS.has(plan)) {
    return "Workspace and enterprise ChatGPT plans are not supported by this independent App Server client.";
  }
  return `The active ChatGPT plan (${planType}) is not recognized as a supported personal plan, so redemption is disabled.`;
}

export function redemptionAccountError(account: AccountSnapshot): string | null {
  return redemptionIdentityError(account) ?? redemptionPlanError(account.planType);
}

export function accountFingerprint(account: AccountSnapshot): string {
  const email = account.email?.trim().toLowerCase();
  if (account.type !== "chatgpt" || email == null || email.length === 0) {
    throw new Error("A ChatGPT account email is required to create a redemption fingerprint.");
  }
  return createHash("sha256").update(`chatgpt\0${email}`, "utf8").digest("hex");
}

export function publicAccountFingerprint(account: AccountSnapshot): string | null {
  try {
    return accountFingerprint(account).slice(0, 16);
  } catch {
    return null;
  }
}

export function maskAccountEmail(account: AccountSnapshot): string | null {
  const email = account.email?.trim();
  if (email == null) {
    return null;
  }
  const separator = email.lastIndexOf("@");
  if (separator <= 0 || separator === email.length - 1) {
    return "[unavailable]";
  }
  const local = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  const maskedLocal = `${local.slice(0, 1)}***`;
  const domainParts = domain.split(".");
  const host = domainParts.shift() ?? "";
  const suffix = domainParts.length === 0 ? "" : `.${domainParts.join(".")}`;
  return `${maskedLocal}@${host.slice(0, 1)}***${suffix}`;
}
