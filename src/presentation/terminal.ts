import { createInterface } from "node:readline/promises";
import type { AccountSnapshot } from "../app-server/schemas.js";
import { maskAccountEmail } from "../application/account.js";
import type { CommandEnvelope, PublicSnapshot } from "../application/output.js";
import { confirmationChallenge } from "../application/redemption-intent.js";
import { getRateLimitBuckets, type RateLimitSnapshot } from "../domain/rate-limit.js";
import type { RedemptionAttempt } from "../domain/redemption-attempt.js";
import type { VerificationResult } from "../domain/verification.js";
import { redactText, safeTerminalField } from "../security/redact.js";

export function formatTimestamp(epochSeconds: number | null, timeZone: string): string {
  if (epochSeconds == null) {
    return "unknown";
  }
  return `${new Intl.DateTimeFormat(undefined, {
    timeZone,
    dateStyle: "medium",
    timeStyle: "long",
  }).format(
    new Date(epochSeconds * 1_000),
  )} [${safeTerminalField(timeZone)}; unix ${epochSeconds}]`;
}

function renderSnapshot(snapshot: PublicSnapshot, timeZone: string): string[] {
  const lines = [
    `Reset credits: ${snapshot.resetCredits.availableCount} (${snapshot.resetCredits.detailsState})`,
  ];

  for (const credit of snapshot.resetCredits.credits) {
    lines.push(`  - ${safeTerminalField(credit.id)}`);
    lines.push(`    status: ${safeTerminalField(credit.status)}`);
    lines.push(`    type: ${safeTerminalField(credit.resetType ?? "unknown")}`);
    lines.push(`    expires: ${formatTimestamp(credit.expiresAt, timeZone)}`);
  }

  for (const [id, bucket] of Object.entries(snapshot.rateLimits.byLimitId)) {
    for (const [windowName, window] of [
      ["primary", bucket.primary],
      ["secondary", bucket.secondary],
    ] as const) {
      if (window != null) {
        lines.push(
          `Rate limit ${safeTerminalField(id)}:${windowName}: ${String(window.usedPercent)}% used; resets ${formatTimestamp(window.resetsAt, timeZone)}`,
        );
      }
    }
  }
  if (
    Object.keys(snapshot.rateLimits.byLimitId).length === 0 &&
    snapshot.rateLimits.current?.primary != null
  ) {
    const bucket = snapshot.rateLimits.current;
    const primary = bucket.primary;
    if (primary == null) {
      return lines;
    }
    lines.push(
      `Rate limit ${safeTerminalField(bucket.limitId ?? "default")}: ${String(primary.usedPercent)}% used; resets ${formatTimestamp(primary.resetsAt, timeZone)}`,
    );
  }

  return lines;
}

export function renderTerminal(envelope: CommandEnvelope, timeZone: string): string {
  const lines: string[] = [];
  if (envelope.account != null) {
    const fingerprint =
      envelope.account.fingerprint == null ? "unavailable" : envelope.account.fingerprint;
    lines.push(
      `Account: ${safeTerminalField(envelope.account.type ?? "unknown")}${
        envelope.account.planType == null
          ? ""
          : ` (${safeTerminalField(envelope.account.planType)})`
      }; fingerprint ${safeTerminalField(fingerprint)}`,
    );
  }

  if (envelope.rateLimits != null && envelope.resetCredits != null) {
    lines.push(
      ...renderSnapshot(
        { rateLimits: envelope.rateLimits, resetCredits: envelope.resetCredits },
        timeZone,
      ),
    );
  }

  for (const check of envelope.diagnostics) {
    lines.push(
      `${check.ok ? "OK" : "WARN"} ${safeTerminalField(check.name)}: ${safeTerminalField(check.message, 1_024)}`,
    );
  }

  if (envelope.redemption != null) {
    lines.push(`Attempt: ${safeTerminalField(envelope.redemption.attemptId)}`);
    lines.push(`Attempt state: ${envelope.redemption.state}`);
    lines.push(
      `Selector: ${safeTerminalField(JSON.stringify(envelope.redemption.requestedSelector))}`,
    );
    lines.push(`Credit ID: ${safeTerminalField(envelope.redemption.creditId)}`);
    lines.push(
      `Credit expires: ${formatTimestamp(
        envelope.redemption.selectedCredit.expiresAt,
        envelope.redemption.timeZone,
      )}`,
    );
    lines.push(
      `Confirmation deadline: ${formatTimestamp(
        envelope.redemption.confirmationExpiresAt,
        envelope.redemption.timeZone,
      )}`,
    );
    if (envelope.redemption.outcome != null) {
      lines.push(`Consume outcome: ${safeTerminalField(envelope.redemption.outcome)}`);
    }
    if (envelope.redemption.recoveryCommand != null) {
      lines.push(`Recovery: ${safeTerminalField(envelope.redemption.recoveryCommand)}`);
    }
  }

  if (envelope.verification != null) {
    lines.push(`Verification: ${envelope.verification.status}`);
    lines.push(`Available count delta: ${String(envelope.verification.availableCountDelta)}`);
    lines.push(
      `Exact target still available: ${String(envelope.verification.targetAvailableAfter)}`,
    );
    lines.push(
      `Natural rollover possible: ${String(envelope.verification.naturalRolloverPossible)}`,
    );
    for (const window of envelope.verification.changedWindows) {
      lines.push(`Changed window: ${safeTerminalField(window)}`);
    }
    lines.push(...envelope.verification.notes.map((note) => `  ${safeTerminalField(note, 1_024)}`));
  }

  lines.push(
    ...envelope.warnings.map((warning) => `Warning: ${safeTerminalField(warning, 1_024)}`),
  );
  if (envelope.error != null) {
    lines.push(
      `Error [${safeTerminalField(envelope.error.code)}]: ${safeTerminalField(envelope.error.message, 1_024)}`,
    );
    for (const candidate of envelope.error.candidates) {
      lines.push(`  candidate: ${safeTerminalField(candidate.id)}`);
    }
  }

  return redactText(lines.join("\n"));
}

function writeConfirmationSnapshot(
  attempt: RedemptionAttempt,
  account: AccountSnapshot,
  snapshot: RateLimitSnapshot,
): void {
  const maskedEmail = maskAccountEmail(account) ?? "unavailable";
  process.stderr.write("\nIrreversible reset-credit redemption\n");
  process.stderr.write(`Account: ${safeTerminalField(maskedEmail)}\n`);
  process.stderr.write(`Account fingerprint: ${attempt.accountFingerprint.slice(0, 16)}\n`);
  process.stderr.write(`Plan: ${safeTerminalField(attempt.planType ?? "unknown")}\n`);
  process.stderr.write(`Available credits: ${snapshot.resetCredits.availableCount}\n`);
  process.stderr.write(`Credit ID: ${safeTerminalField(attempt.target.id)}\n`);
  process.stderr.write(`Credit type: ${attempt.target.resetType}\n`);
  process.stderr.write(`Expires: ${formatTimestamp(attempt.target.expiresAt, attempt.timeZone)}\n`);
  for (const [bucketId, bucket] of getRateLimitBuckets(snapshot)) {
    for (const [name, window] of [
      ["primary", bucket.primary],
      ["secondary", bucket.secondary],
    ] as const) {
      if (window != null) {
        process.stderr.write(
          `Window ${safeTerminalField(bucketId)}:${name}: ${String(window.usedPercent)}% used; resets ${formatTimestamp(window.resetsAt, attempt.timeZone)}\n`,
        );
      }
    }
  }
  process.stderr.write(
    "The account and full safety snapshot will be checked again after confirmation.\n",
  );
}

export async function confirmPreparedRedemption(
  attempt: Readonly<RedemptionAttempt>,
  account: Readonly<AccountSnapshot>,
  snapshot: Readonly<RateLimitSnapshot>,
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    return false;
  }
  writeConfirmationSnapshot(
    attempt as RedemptionAttempt,
    account as AccountSnapshot,
    snapshot as RateLimitSnapshot,
  );
  const expected = confirmationChallenge(attempt as RedemptionAttempt);
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await reader.question(`Type ${expected} to continue: `);
    return answer === expected;
  } finally {
    reader.close();
  }
}

export async function confirmRecovery(
  attempt: Readonly<RedemptionAttempt>,
  account: Readonly<AccountSnapshot>,
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    return false;
  }
  const expected = `RECOVER ${attempt.attemptId.slice(0, 8).toUpperCase()}`;
  process.stderr.write("\nIrreversible reset-credit recovery\n");
  process.stderr.write(`Attempt: ${safeTerminalField(attempt.attemptId)} (${attempt.state})\n`);
  process.stderr.write(
    `Account: ${safeTerminalField(maskAccountEmail(account) ?? "unavailable")}\n`,
  );
  process.stderr.write(`Account fingerprint: ${attempt.accountFingerprint.slice(0, 16)}\n`);
  process.stderr.write(`Plan: ${safeTerminalField(attempt.planType ?? "unknown")}\n`);
  process.stderr.write(`Credit ID: ${safeTerminalField(attempt.target.id)}\n`);
  process.stderr.write(`Credit type: ${attempt.target.resetType}\n`);
  process.stderr.write(`Expires: ${formatTimestamp(attempt.target.expiresAt, attempt.timeZone)}\n`);
  process.stderr.write(
    "This attempt may already have completed. Recovery first reconciles read-only, then may resend only the same journaled key and exact credit ID; it never creates a new logical attempt.\n",
  );
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await reader.question(
      `Type ${expected} to reconcile/replay this exact attempt: `,
    );
    return answer === expected;
  } finally {
    reader.close();
  }
}

export async function confirmCloseUnknown(
  attempt: Readonly<RedemptionAttempt>,
  account: Readonly<AccountSnapshot>,
  verification: Readonly<VerificationResult>,
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    return false;
  }
  const expected = `CLOSE UNKNOWN ${attempt.attemptId.slice(0, 8).toUpperCase()}`;
  process.stderr.write("\nClose an unprovable reset-credit attempt\n");
  process.stderr.write(`Attempt: ${safeTerminalField(attempt.attemptId)} (${attempt.state})\n`);
  process.stderr.write(
    `Account: ${safeTerminalField(maskAccountEmail(account) ?? "unavailable")}\n`,
  );
  process.stderr.write(`Account fingerprint: ${attempt.accountFingerprint.slice(0, 16)}\n`);
  process.stderr.write(`Plan: ${safeTerminalField(attempt.planType ?? "unknown")}\n`);
  process.stderr.write(`Credit ID: ${safeTerminalField(attempt.target.id)}\n`);
  process.stderr.write(`Expires: ${formatTimestamp(attempt.target.expiresAt, attempt.timeZone)}\n`);
  process.stderr.write(`Current proof: ${verification.status}\n`);
  for (const note of verification.notes) {
    process.stderr.write(`  ${safeTerminalField(note, 1_024)}\n`);
  }
  process.stderr.write(
    "This sends nothing and does not decide whether the old request completed. It permanently disables replay of this attempt and allows future attempts to proceed.\n",
  );
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await reader.question(`Type ${expected} to close the unknown journal: `);
    return answer === expected;
  } finally {
    reader.close();
  }
}
