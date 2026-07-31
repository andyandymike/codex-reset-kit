import { createInterface } from "node:readline/promises";
import type { CommandEnvelope, PublicSnapshot } from "../application/output.js";
import type { RateLimitSnapshot } from "../domain/rate-limit.js";
import type { SelectedCredit } from "../domain/select-credit.js";
import { redactText } from "../security/redact.js";

export function formatTimestamp(epochSeconds: number | null, timeZone: string): string {
  if (epochSeconds == null) {
    return "unknown";
  }
  return `${new Intl.DateTimeFormat(undefined, {
    timeZone,
    dateStyle: "medium",
    timeStyle: "long",
  }).format(new Date(epochSeconds * 1_000))} (${epochSeconds})`;
}

function renderSnapshot(snapshot: PublicSnapshot, timeZone: string): string[] {
  const lines = [
    `Reset credits: ${snapshot.resetCredits.availableCount} (${snapshot.resetCredits.detailsState})`,
  ];

  for (const credit of snapshot.resetCredits.credits) {
    lines.push(`  - ${credit.id}`);
    lines.push(`    status: ${credit.status}`);
    lines.push(`    expires: ${formatTimestamp(credit.expiresAt, timeZone)}`);
  }

  for (const [id, bucket] of Object.entries(snapshot.rateLimits.byLimitId)) {
    const primary = bucket.primary;
    if (primary != null) {
      lines.push(
        `Rate limit ${id}: ${String(primary.usedPercent)}% used; resets ${formatTimestamp(primary.resetsAt, timeZone)}`,
      );
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
      `Rate limit ${bucket.limitId ?? "default"}: ${String(primary.usedPercent)}% used; resets ${formatTimestamp(primary.resetsAt, timeZone)}`,
    );
  }

  return lines;
}

export function renderTerminal(envelope: CommandEnvelope, timeZone: string): string {
  const lines: string[] = [];
  if (envelope.account != null) {
    lines.push(
      `Account: ${envelope.account.type ?? "unknown"}${envelope.account.planType == null ? "" : ` (${envelope.account.planType})`}`,
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
    lines.push(`${check.ok ? "OK" : "WARN"} ${check.name}: ${check.message}`);
  }

  if (envelope.redemption != null) {
    lines.push(`Selector: ${JSON.stringify(envelope.redemption.requestedSelector)}`);
    lines.push(`Credit ID: ${envelope.redemption.creditId ?? "service-selected"}`);
    if (envelope.redemption.idempotencyKey != null) {
      lines.push(`Idempotency key: ${envelope.redemption.idempotencyKey}`);
    }
    if (envelope.redemption.outcome != null) {
      lines.push(`Consume outcome: ${envelope.redemption.outcome}`);
    }
  }

  if (envelope.verification != null) {
    lines.push(`Verification: ${envelope.verification.status}`);
    lines.push(...envelope.verification.notes.map((note) => `  ${note}`));
  }

  lines.push(...envelope.warnings.map((warning) => `Warning: ${warning}`));
  if (envelope.error != null) {
    lines.push(`Error [${envelope.error.code}]: ${envelope.error.message}`);
    for (const candidate of envelope.error.candidates) {
      lines.push(`  candidate: ${candidate.id}`);
    }
  }

  return redactText(lines.join("\n"));
}

export async function confirmRedemption(
  selection: SelectedCredit,
  _before: RateLimitSnapshot,
  timeZone: string,
): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }

  const target =
    selection.credit != null
      ? `${selection.credit.id}, expiring ${formatTimestamp(selection.credit.expiresAt, timeZone)}`
      : selection.creditId != null
        ? `credit ID ${selection.creditId} (current details cannot re-prove it)`
        : "the next service-selected reset credit (expiration cannot be proven)";
  process.stderr.write(`About to irreversibly redeem ${target}.\n`);
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await reader.question("Type REDEEM to continue: ");
    return answer === "REDEEM";
  } finally {
    reader.close();
  }
}
