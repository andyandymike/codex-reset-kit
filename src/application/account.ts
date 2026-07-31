import type { AccountSnapshot } from "../app-server/schemas.js";

const CHATGPT_ACCOUNT_TYPES = new Set([
  "chatgpt",
  "chatgptAuthTokens",
  "agentIdentity",
  "personalAccessToken",
]);

export function compatibleAccountError(account: AccountSnapshot): string | null {
  if (account.type == null) {
    return account.requiresOpenaiAuth
      ? "Codex is not signed in. Sign in with ChatGPT through Codex first."
      : "The active Codex provider does not expose ChatGPT rate limits.";
  }
  if (!CHATGPT_ACCOUNT_TYPES.has(account.type)) {
    return `The active Codex account type (${account.type}) cannot use ChatGPT reset credits.`;
  }
  return null;
}
