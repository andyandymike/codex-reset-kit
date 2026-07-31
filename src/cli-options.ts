import { parseArgs } from "node:util";
import type { CreditSelector } from "./domain/select-credit.js";
import { validateCalendarDate, validateTimeZone } from "./domain/select-credit.js";

export interface CommonCliOptions {
  json: boolean;
  codexBin: string;
  timeoutMs: number;
  timeZone: string;
}

export type ParsedCommand =
  | { command: "help"; common: CommonCliOptions }
  | { command: "list"; common: CommonCliOptions }
  | { command: "doctor"; common: CommonCliOptions }
  | {
      command: "redeem";
      common: CommonCliOptions;
      selector: CreditSelector;
      yes: boolean;
      idempotencyKey?: string;
    };

export class CliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgumentError";
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface CliValues {
  json?: boolean;
  yes?: boolean;
  help?: boolean;
  "credit-id"?: string;
  earliest?: boolean;
  "expires-on"?: string;
  timezone?: string;
  next?: boolean;
  "codex-bin"?: string;
  timeout?: string;
  "idempotency-key"?: string;
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined) {
    return 15_000;
  }
  if (!/^\d+$/.test(value)) {
    throw new CliArgumentError("--timeout must be an integer number of milliseconds.");
  }
  const timeoutMs = Number(value);
  if (timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new CliArgumentError("--timeout must be between 1000 and 120000 milliseconds.");
  }
  return timeoutMs;
}

export function parseCliArgs(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): ParsedCommand {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: "boolean" },
        yes: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        "credit-id": { type: "string" },
        earliest: { type: "boolean" },
        "expires-on": { type: "string" },
        timezone: { type: "string" },
        next: { type: "boolean" },
        "codex-bin": { type: "string" },
        timeout: { type: "string" },
        "idempotency-key": { type: "string" },
      },
    });
  } catch (error) {
    throw new CliArgumentError(error instanceof Error ? error.message : String(error));
  }

  const values = parsed.values as CliValues;

  const command = parsed.positionals[0] ?? "help";
  if (parsed.positionals.length > 1) {
    throw new CliArgumentError("Only one subcommand is allowed.");
  }
  if (!new Set(["help", "list", "doctor", "redeem"]).has(command)) {
    throw new CliArgumentError(`Unknown command: ${command}.`);
  }

  const timeZone = values.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  if (!validateTimeZone(timeZone)) {
    throw new CliArgumentError(`Invalid IANA time zone: ${timeZone}.`);
  }
  const common: CommonCliOptions = {
    json: values.json ?? false,
    codexBin: values["codex-bin"] ?? environment.CODEX_BIN ?? "codex",
    timeoutMs: parseTimeout(values.timeout),
    timeZone,
  };

  if (values.help === true || command === "help") {
    return { command: "help", common };
  }
  if (command === "list" || command === "doctor") {
    const hasRedemptionOption =
      values.yes === true ||
      values["credit-id"] !== undefined ||
      values.earliest === true ||
      values["expires-on"] !== undefined ||
      values.next === true ||
      values["idempotency-key"] !== undefined;
    if (hasRedemptionOption) {
      throw new CliArgumentError(`Redemption options are not valid for ${command}.`);
    }
    return { command, common };
  }

  const selectors: CreditSelector[] = [];
  if (values["credit-id"] !== undefined) {
    if (values["credit-id"].length === 0) {
      throw new CliArgumentError("--credit-id cannot be empty.");
    }
    selectors.push({ kind: "id", id: values["credit-id"] });
  }
  if (values.earliest === true) {
    selectors.push({ kind: "earliest" });
  }
  if (values["expires-on"] !== undefined) {
    if (!validateCalendarDate(values["expires-on"])) {
      throw new CliArgumentError("--expires-on must be a real date in YYYY-MM-DD form.");
    }
    selectors.push({
      kind: "expires-on",
      date: values["expires-on"],
      timeZone,
    });
  }
  if (values.next === true) {
    selectors.push({ kind: "next" });
  }
  if (selectors.length !== 1) {
    throw new CliArgumentError(
      "redeem requires exactly one of --credit-id, --earliest, --expires-on, or --next.",
    );
  }

  const idempotencyKey = values["idempotency-key"];
  if (idempotencyKey !== undefined && !UUID_PATTERN.test(idempotencyKey)) {
    throw new CliArgumentError("--idempotency-key must be a valid UUID.");
  }
  const selector = selectors[0] as CreditSelector;
  if (idempotencyKey !== undefined && selector.kind !== "id" && selector.kind !== "next") {
    throw new CliArgumentError(
      "Idempotent recovery requires --credit-id with the previously printed ID, or --next if the original request used --next.",
    );
  }

  return {
    command: "redeem",
    common,
    selector,
    yes: values.yes ?? false,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };
}

export const HELP_TEXT = `Codex Reset Kit

Safely inspect and redeem earned Codex rate-limit resets.

Usage:
  codex-reset list [--json]
  codex-reset doctor [--json]
  codex-reset redeem --credit-id <id> [--yes] [--json]
  codex-reset redeem --earliest [--yes] [--json]
  codex-reset redeem --expires-on <YYYY-MM-DD> [--timezone <iana>] [--yes] [--json]
  codex-reset redeem --next [--yes] [--json]

Common options:
  --codex-bin <path>        Codex executable (or set CODEX_BIN)
  --timeout <ms>            Request timeout, 1000-120000 (default: 15000)
  --json                    Print a stable JSON envelope
  --idempotency-key <uuid>  Resume the same logical redemption attempt

Safety:
  list and doctor never consume a reset. redeem requires one explicit selector and
  interactive confirmation; --yes is only for a caller that already obtained explicit consent.
`;
