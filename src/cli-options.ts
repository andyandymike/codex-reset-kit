import { parseArgs } from "node:util";
import type { CreditSelector } from "./domain/select-credit.js";
import { validateCalendarDate, validateTimeZone } from "./domain/select-credit.js";
import { hasControlCharacters } from "./security/redact.js";

export interface CommonCliOptions {
  json: boolean;
  verbose: boolean;
  codexBin: string;
  timeoutMs: number;
  timeZone: string;
}

export type ParsedCommand =
  | { command: "help"; common: CommonCliOptions }
  | { command: "list"; common: CommonCliOptions }
  | { command: "doctor"; common: CommonCliOptions }
  | { command: "prepare" | "redeem"; common: CommonCliOptions; selector: CreditSelector }
  | { command: "commit" | "recover"; common: CommonCliOptions; attemptId: string };

export class CliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgumentError";
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface CliValues {
  json?: boolean;
  verbose?: boolean;
  help?: boolean;
  "credit-id"?: string;
  earliest?: boolean;
  "expires-on"?: string;
  timezone?: string;
  attempt?: string;
  "codex-bin"?: string;
  timeout?: string;
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

function parseSelector(values: CliValues, timeZone: string): CreditSelector {
  const selectors: CreditSelector[] = [];
  if (values["credit-id"] !== undefined) {
    if (values["credit-id"].length === 0 || hasControlCharacters(values["credit-id"])) {
      throw new CliArgumentError("--credit-id is empty or contains control characters.");
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
    selectors.push({ kind: "expires-on", date: values["expires-on"], timeZone });
  }
  if (selectors.length !== 1) {
    throw new CliArgumentError(
      "prepare and redeem require exactly one of --credit-id, --earliest, or --expires-on.",
    );
  }
  return selectors[0] as CreditSelector;
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
        verbose: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        "credit-id": { type: "string" },
        earliest: { type: "boolean" },
        "expires-on": { type: "string" },
        timezone: { type: "string" },
        attempt: { type: "string" },
        "codex-bin": { type: "string" },
        timeout: { type: "string" },
      },
    });
  } catch (error) {
    throw new CliArgumentError(error instanceof Error ? error.message : String(error));
  }

  const values = parsed.values as CliValues;
  const command = (parsed.positionals[0] ?? "help") as ParsedCommand["command"];
  if (parsed.positionals.length > 1) {
    throw new CliArgumentError("Only one subcommand is allowed.");
  }
  if (!new Set(["help", "list", "doctor", "prepare", "redeem", "commit", "recover"]).has(command)) {
    throw new CliArgumentError(`Unknown command: ${command}.`);
  }

  const timeZone = values.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  if (!validateTimeZone(timeZone)) {
    throw new CliArgumentError(`Invalid IANA time zone: ${timeZone}.`);
  }
  const common: CommonCliOptions = {
    json: values.json ?? false,
    verbose: values.verbose ?? false,
    codexBin: values["codex-bin"] ?? environment.CODEX_BIN ?? "codex",
    timeoutMs: parseTimeout(values.timeout),
    timeZone,
  };

  if (values.help === true || command === "help") {
    return { command: "help", common };
  }

  const hasSelector =
    values["credit-id"] !== undefined ||
    values.earliest === true ||
    values["expires-on"] !== undefined;

  if (command === "list" || command === "doctor") {
    if (hasSelector || values.attempt !== undefined) {
      throw new CliArgumentError(`Selection and attempt options are not valid for ${command}.`);
    }
    return { command, common };
  }

  if (command === "prepare" || command === "redeem") {
    if (values.attempt !== undefined) {
      throw new CliArgumentError(`--attempt is not valid for ${command}.`);
    }
    return { command, common, selector: parseSelector(values, timeZone) };
  }

  if (hasSelector || values.timezone !== undefined) {
    throw new CliArgumentError(`Selectors and --timezone are not valid for ${command}.`);
  }
  if (values.attempt == null || !UUID_PATTERN.test(values.attempt)) {
    throw new CliArgumentError(
      `${command} requires --attempt with a valid journaled attempt UUID.`,
    );
  }
  return { command, common, attemptId: values.attempt };
}

export const HELP_TEXT = `Codex Reset Kit

Inspect earned Codex reset credits and redeem one through a bound local confirmation.

Usage:
  codex-reset list [--json]
  codex-reset doctor [--json]
  codex-reset prepare --credit-id <id> [--json]
  codex-reset prepare --earliest [--json]
  codex-reset prepare --expires-on <YYYY-MM-DD> [--timezone <iana>] [--json]
  codex-reset redeem <same selector options>
  codex-reset commit --attempt <uuid>
  codex-reset recover --attempt <uuid>

Common options:
  --codex-bin <path>  Codex executable (or set CODEX_BIN)
  --timeout <ms>      Request timeout, 1000-120000 (default: 15000)
  --json              Print a stable JSON envelope
  --verbose           Print sanitized App Server diagnostics to stderr

Safety:
  list, doctor, and prepare never consume a reset. commit, redeem, and recover require
  a local interactive terminal. There is no --yes option and no caller-supplied idempotency key.
  An old unknown attempt can be closed only by a separate local phrase after replay expires.
`;
