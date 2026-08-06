import { z } from "zod";
import type { CodexAppServerClient } from "../app-server/client.js";
import { connectAppServer } from "../app-server/client.js";
import { isAppServerError } from "../app-server/errors.js";
import {
  type AttemptStateDirectoryInspection,
  AttemptStoreError,
  defaultAttemptStateDirectory,
  FileRedemptionAttemptStore,
  inspectAttemptStateDirectory,
  type RedemptionAttemptStore,
} from "../application/attempt-store.js";
import { runDoctor } from "../application/doctor.js";
import { runList } from "../application/list.js";
import {
  type CommandEnvelope,
  type CommandExecution,
  createEnvelope,
  EXIT_CODE,
  fail,
} from "../application/output.js";
import {
  runCommitRedemption,
  runPrepareRedemption,
  runRecoverRedemption,
} from "../application/redeem.js";
import { confirmationChallenge } from "../application/redemption-intent.js";
import { RECOVERY_ATTEMPT_TTL_MS, type RedemptionAttempt } from "../domain/redemption-attempt.js";
import {
  type CreditSelector,
  validateCalendarDate,
  validateTimeZone,
} from "../domain/select-credit.js";
import { formatTimestamp, renderTerminal } from "../presentation/terminal.js";
import {
  formatCreditId,
  hasControlCharacters,
  redactText,
  safeTerminalField,
} from "../security/redact.js";

const VERSION = "0.1.0";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PREFIX_PATTERN = /^[0-9a-f]{16}$/i;
const MAX_CREDIT_ID_LENGTH = 1_024;

export const RESET_MCP_TOOL_NAMES = [
  "check_remote_reset_setup",
  "list_reset_credits",
  "prepare_reset_redemption",
  "get_redemption_attempt",
  "redeem_prepared_reset",
  "recover_reset_redemption",
] as const;

export type ResetMcpToolName = (typeof RESET_MCP_TOOL_NAMES)[number];

export interface McpToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
  idempotentHint?: boolean;
}

export interface ResetMcpToolDefinition {
  name: ResetMcpToolName;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: McpToolAnnotations;
}

const approvalBindingProperties = {
  attempt_id: {
    type: "string",
    description: "The UUID of the durable prepared attempt.",
    pattern: UUID_PATTERN.source,
  },
  account_fingerprint: {
    type: "string",
    description: "The 16-character public prefix of the bound account fingerprint.",
    pattern: HASH_PREFIX_PATTERN.source,
  },
  credit_id: {
    type: "string",
    description: "The exact opaque reset-credit ID returned by preparation.",
    minLength: 1,
    maxLength: MAX_CREDIT_ID_LENGTH,
  },
  expires_at: {
    type: "integer",
    description: "The exact target expiration as Unix seconds.",
    minimum: 0,
  },
  confirmation_expires_at: {
    type: "integer",
    description: "The prepared confirmation deadline as Unix seconds.",
    minimum: 0,
  },
} as const;

export const RESET_MCP_TOOLS: ResetMcpToolDefinition[] = [
  {
    name: "check_remote_reset_setup",
    title: "Check Codex Remote reset setup",
    description:
      "Read-only preflight for the connected host, account, reset-credit details, negotiated MCP protocol, and required in-client form confirmation. This never prepares or consumes a credit.",
    inputSchema: {
      type: "object",
      properties: {
        time_zone: {
          type: "string",
          description: "IANA time zone used only to format any returned timestamps.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "list_reset_credits",
    title: "List Codex reset credits",
    description:
      "Read the active ChatGPT account's earned Codex reset-credit count and available exact credit details. This never consumes a credit.",
    inputSchema: {
      type: "object",
      properties: {
        time_zone: {
          type: "string",
          description: "IANA time zone used only to format expiration timestamps.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "prepare_reset_redemption",
    title: "Prepare one exact Codex reset",
    description:
      "Resolve one reset credit by ID, earliest expiry, or local calendar date and write a short-lived exact local intent. This does not consume a credit. For a date selector, time_zone is required.",
    inputSchema: {
      type: "object",
      properties: {
        credit_id: {
          type: "string",
          description: "Exact opaque reset-credit ID.",
          minLength: 1,
          maxLength: MAX_CREDIT_ID_LENGTH,
        },
        earliest: {
          type: "boolean",
          description: "Set to true to select the uniquely earliest expiring credit.",
        },
        expires_on: {
          type: "string",
          description: "Local calendar date in YYYY-MM-DD form.",
          pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
        },
        time_zone: {
          type: "string",
          description: "IANA time zone. Required with expires_on.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "get_redemption_attempt",
    title: "Inspect a reset attempt",
    description:
      "Read one local reset-attempt journal by UUID without consuming, replaying, closing, or changing it.",
    inputSchema: {
      type: "object",
      properties: {
        attempt_id: approvalBindingProperties.attempt_id,
      },
      required: ["attempt_id"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "redeem_prepared_reset",
    title: "Use the exact prepared Codex reset credit",
    description:
      "IRREVERSIBLE: consume the exact account-bound credit from a short-lived prepared attempt. The host must approve this destructive call, and the server asks the user to type an attempt-specific confirmation before sending.",
    inputSchema: {
      type: "object",
      properties: approvalBindingProperties,
      required: Object.keys(approvalBindingProperties),
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "recover_reset_redemption",
    title: "Recover the exact uncertain Codex reset attempt",
    description:
      "IRREVERSIBLE IN SOME STATES: reconcile an uncertain attempt, then only after a bound user confirmation either replay the same idempotency key and exact credit, or close an old unprovable journal without sending. Never creates a new logical attempt.",
    inputSchema: {
      type: "object",
      properties: approvalBindingProperties,
      required: Object.keys(approvalBindingProperties),
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
      idempotentHint: true,
    },
  },
];

const timeZoneSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => validateTimeZone(value), "time_zone must be a valid IANA time zone");

const listInputSchema = z
  .object({
    time_zone: timeZoneSchema.optional(),
  })
  .strict();

const prepareInputSchema = z
  .object({
    credit_id: z
      .string()
      .min(1)
      .max(MAX_CREDIT_ID_LENGTH)
      .refine((value) => !hasControlCharacters(value), "credit_id contains control characters")
      .optional(),
    earliest: z.literal(true).optional(),
    expires_on: z
      .string()
      .refine((value) => validateCalendarDate(value), "expires_on must be a real YYYY-MM-DD date")
      .optional(),
    time_zone: timeZoneSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const selectors = [
      value.credit_id !== undefined,
      value.earliest === true,
      value.expires_on !== undefined,
    ];
    if (selectors.filter(Boolean).length !== 1) {
      context.addIssue({
        code: "custom",
        message: "exactly one of credit_id, earliest, or expires_on is required",
      });
    }
    if (value.expires_on !== undefined && value.time_zone === undefined) {
      context.addIssue({
        code: "custom",
        path: ["time_zone"],
        message: "time_zone is required with expires_on",
      });
    }
  });

const attemptInputSchema = z
  .object({
    attempt_id: z.string().regex(UUID_PATTERN),
  })
  .strict();

const approvalBindingSchema = z
  .object({
    attempt_id: z.string().regex(UUID_PATTERN),
    account_fingerprint: z.string().regex(HASH_PREFIX_PATTERN),
    credit_id: z
      .string()
      .min(1)
      .max(MAX_CREDIT_ID_LENGTH)
      .refine((value) => !hasControlCharacters(value), "credit_id contains control characters"),
    expires_at: z.number().int().nonnegative(),
    confirmation_expires_at: z.number().int().nonnegative(),
  })
  .strict();

export type ApprovalBinding = z.infer<typeof approvalBindingSchema>;

export interface RemoteConfirmationRequest {
  kind: "redeem" | "recover" | "close-unknown";
  challenge: string;
  message: string;
  expiresAt: number | null;
}

export interface ResetMcpCallContext {
  signal: AbortSignal;
  clientCapabilities: {
    protocolVersion: string | null;
    formElicitation: boolean;
  };
  requestConfirmation(request: RemoteConfirmationRequest): Promise<boolean>;
}

export interface ResetMcpCallResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

export interface ResetMcpToolServiceDependencies {
  connect?: () => Promise<CodexAppServerClient>;
  store?: RedemptionAttemptStore;
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
  verificationDelaysMs?: number[];
  sleep?: (milliseconds: number) => Promise<void>;
  inspectStateDirectory?: () => Promise<AttemptStateDirectoryInspection>;
}

function defaultTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function parseTimeout(environment: NodeJS.ProcessEnv): number {
  const raw = environment.CODEX_RESET_MCP_APP_SERVER_TIMEOUT_MS;
  if (raw == null) {
    return 15_000;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error("CODEX_RESET_MCP_APP_SERVER_TIMEOUT_MS must be an integer.");
  }
  const value = Number(raw);
  if (value < 1_000 || value > 120_000) {
    throw new Error("CODEX_RESET_MCP_APP_SERVER_TIMEOUT_MS must be between 1000 and 120000.");
  }
  return value;
}

function selectorFromInput(input: z.infer<typeof prepareInputSchema>): CreditSelector {
  if (input.credit_id !== undefined) {
    return { kind: "id", id: input.credit_id };
  }
  if (input.earliest === true) {
    return { kind: "earliest" };
  }
  if (input.expires_on !== undefined && input.time_zone !== undefined) {
    return { kind: "expires-on", date: input.expires_on, timeZone: input.time_zone };
  }
  throw new Error("A valid exact selector is required.");
}

export function approvalBinding(attempt: RedemptionAttempt): ApprovalBinding {
  return {
    attempt_id: attempt.attemptId,
    account_fingerprint: attempt.accountFingerprint.slice(0, 16),
    credit_id: attempt.target.id,
    expires_at: attempt.target.expiresAt,
    confirmation_expires_at: Math.floor(attempt.expiresAt / 1_000),
  };
}

function bindingMatches(attempt: RedemptionAttempt, binding: ApprovalBinding): boolean {
  const expected = approvalBinding(attempt);
  return (
    binding.attempt_id === expected.attempt_id &&
    binding.account_fingerprint === expected.account_fingerprint &&
    binding.credit_id === expected.credit_id &&
    binding.expires_at === expected.expires_at &&
    binding.confirmation_expires_at === expected.confirmation_expires_at
  );
}

function publicAttempt(attempt: RedemptionAttempt, now: number): Record<string, unknown> {
  const binding = approvalBinding(attempt);
  let nextAction: "redeem_prepared_reset" | "recover_reset_redemption" | "none" = "none";
  if (attempt.state === "prepared") {
    nextAction = "redeem_prepared_reset";
  } else if (attempt.state === "sending" || attempt.state === "outcome-unknown") {
    nextAction = "recover_reset_redemption";
  }
  return {
    schemaVersion: 1,
    state: attempt.state,
    planType: attempt.planType,
    selector: attempt.requestedSelector,
    resetType: attempt.target.resetType,
    timeZone: attempt.timeZone,
    targetExpiresAt: attempt.target.expiresAt,
    confirmationExpiresAt: Math.floor(attempt.expiresAt / 1_000),
    recoveryReplayExpiresAt: Math.floor((attempt.createdAt + RECOVERY_ATTEMPT_TTL_MS) / 1_000),
    recoveryReplayExpired: now - attempt.createdAt >= RECOVERY_ATTEMPT_TTL_MS,
    outcome: attempt.outcome,
    nextAction,
    approval: binding,
  };
}

function remoteEnvelope(execution: CommandExecution): CommandEnvelope {
  const envelope = structuredClone(execution.envelope);
  if (envelope.redemption?.recoveryCommand != null) {
    envelope.redemption.recoveryCommand = null;
  }
  const replaceRecoveryCommand = (value: string): string =>
    value.replace(
      /codex-reset recover --attempt [0-9a-f-]+/gi,
      "recover_reset_redemption with this same approval binding",
    );
  envelope.warnings = envelope.warnings.map(replaceRecoveryCommand);
  if (envelope.error != null) {
    envelope.error.message = replaceRecoveryCommand(envelope.error.message);
  }
  return envelope;
}

function executionText(envelope: CommandEnvelope, timeZone: string): string {
  const rendered = renderTerminal(envelope, timeZone);
  return rendered.length === 0 ? "Codex Reset Kit returned no displayable result." : rendered;
}

function executionResult(
  tool: ResetMcpToolName,
  execution: CommandExecution,
  timeZone: string,
  extra: Record<string, unknown> = {},
): ResetMcpCallResult {
  const envelope = remoteEnvelope(execution);
  return {
    content: [{ type: "text", text: executionText(envelope, timeZone) }],
    structuredContent: {
      schemaVersion: 1,
      tool,
      execution: envelope,
      ...extra,
    },
  };
}

function inputError(tool: ResetMcpToolName, error: unknown): ResetMcpCallResult {
  const message =
    error instanceof z.ZodError
      ? z.prettifyError(error)
      : redactText(error instanceof Error ? error.message : String(error));
  return {
    content: [{ type: "text", text: `Invalid ${tool} input: ${message}` }],
    structuredContent: {
      schemaVersion: 1,
      tool,
      error: { code: "invalid-input", message },
    },
    isError: true,
  };
}

function applicationFailure(
  command: "list" | "doctor" | "prepare" | "commit" | "recover",
  error: unknown,
): CommandExecution {
  const envelope = createEnvelope(command);
  const message = redactText(error instanceof Error ? error.message : String(error));
  if (error instanceof AttemptStoreError) {
    const exitCode =
      error.code === "locked" || error.code === "conflict" ? EXIT_CODE.stale : EXIT_CODE.attempt;
    return fail(envelope, exitCode, `attempt-${error.code}`, message);
  }
  return fail(
    envelope,
    EXIT_CODE.appServer,
    isAppServerError(error) ? `app-server-${error.kind}` : "application-error",
    message,
  );
}

function bindingFailure(
  command: "commit" | "recover",
  attempt: RedemptionAttempt,
): CommandExecution {
  const envelope = createEnvelope(command);
  return fail(
    envelope,
    EXIT_CODE.arguments,
    "approval-binding-mismatch",
    `The approved arguments do not exactly match journaled attempt ${attempt.attemptId}. No consume request was sent.`,
  );
}

function confirmationMessage(
  attempt: RedemptionAttempt,
  kind: RemoteConfirmationRequest["kind"],
): { challenge: string; message: string } {
  const fingerprint = attempt.accountFingerprint.slice(0, 16);
  const creditId = formatCreditId(attempt.target.id);
  const expiration = formatTimestamp(attempt.target.expiresAt, attempt.timeZone);
  if (kind === "close-unknown") {
    const challenge = `CLOSE UNKNOWN ${attempt.attemptId.slice(0, 8).toUpperCase()}`;
    return {
      challenge,
      message: [
        "Close this old unprovable reset attempt?",
        "No consume request will be sent, but replay authority will be permanently lost and the old outcome will remain unknown.",
        `Account fingerprint: ${fingerprint}`,
        `Credit ID: ${creditId}`,
        `Credit expires: ${expiration}`,
        `Type ${challenge} exactly to close the journal.`,
      ].join("\n"),
    };
  }
  if (kind === "recover") {
    const challenge = `RECOVER ${attempt.attemptId.slice(0, 8).toUpperCase()}`;
    return {
      challenge,
      message: [
        "Recover this exact uncertain reset attempt?",
        "It may already have completed. The server will reconcile first and may replay only the same idempotency key and exact credit; no new logical attempt is created.",
        `Account fingerprint: ${fingerprint}`,
        `Credit ID: ${creditId}`,
        `Credit expires: ${expiration}`,
        `Type ${challenge} exactly to continue.`,
      ].join("\n"),
    };
  }
  const challenge = confirmationChallenge(attempt);
  return {
    challenge,
    message: [
      "Use this Codex reset credit now? This is irreversible.",
      `Account fingerprint: ${fingerprint}`,
      `Plan: ${safeTerminalField(attempt.planType ?? "unknown", 128)}`,
      `Credit ID: ${creditId}`,
      `Credit expires: ${expiration}`,
      `Prepared confirmation deadline: ${formatTimestamp(Math.floor(attempt.expiresAt / 1_000), attempt.timeZone)}`,
      "The account and full safety snapshot will be checked again after confirmation.",
      `Type ${challenge} exactly to continue.`,
    ].join("\n"),
  };
}

export class ResetMcpToolService {
  readonly #store: RedemptionAttemptStore;
  readonly #connect: () => Promise<CodexAppServerClient>;
  readonly #now: () => number;
  readonly #verificationDelaysMs: number[] | undefined;
  readonly #sleep: ((milliseconds: number) => Promise<void>) | undefined;
  readonly #inspectStateDirectory: () => Promise<AttemptStateDirectoryInspection>;

  constructor(dependencies: ResetMcpToolServiceDependencies = {}) {
    const environment = dependencies.environment ?? process.env;
    if (dependencies.store == null) {
      const stateDirectory = defaultAttemptStateDirectory(environment);
      this.#store = new FileRedemptionAttemptStore(stateDirectory);
      this.#inspectStateDirectory =
        dependencies.inspectStateDirectory ?? (() => inspectAttemptStateDirectory(stateDirectory));
    } else {
      this.#store = dependencies.store;
      this.#inspectStateDirectory =
        dependencies.inspectStateDirectory ??
        (async () => ({
          ready: true,
          state: "injected",
          message: "The injected journal store is available to this process.",
        }));
    }
    this.#now = dependencies.now ?? Date.now;
    this.#verificationDelaysMs = dependencies.verificationDelaysMs;
    this.#sleep = dependencies.sleep;
    this.#connect =
      dependencies.connect ??
      (() =>
        connectAppServer({
          command: environment.CODEX_BIN ?? "codex",
          timeoutMs: parseTimeout(environment),
          clientVersion: VERSION,
        }));
  }

  async call(
    tool: string,
    rawInput: unknown,
    context: ResetMcpCallContext,
  ): Promise<ResetMcpCallResult> {
    if (!RESET_MCP_TOOL_NAMES.includes(tool as ResetMcpToolName)) {
      return inputError(
        "list_reset_credits",
        new Error(`Unknown tool: ${safeTerminalField(tool)}`),
      );
    }
    const name = tool as ResetMcpToolName;
    try {
      if (name === "get_redemption_attempt") {
        return await this.#getAttempt(attemptInputSchema.parse(rawInput));
      }
      if (name === "check_remote_reset_setup") {
        return await this.#checkRemoteSetup(listInputSchema.parse(rawInput), context);
      }
      if (name === "list_reset_credits") {
        return await this.#list(listInputSchema.parse(rawInput));
      }
      if (name === "prepare_reset_redemption") {
        return await this.#prepare(prepareInputSchema.parse(rawInput));
      }
      const binding = approvalBindingSchema.parse(rawInput);
      return name === "redeem_prepared_reset"
        ? await this.#redeem(binding, context)
        : await this.#recover(binding, context);
    } catch (error) {
      return inputError(name, error);
    }
  }

  async #withClient<T>(operation: (client: CodexAppServerClient) => Promise<T>): Promise<T> {
    const client = await this.#connect();
    try {
      return await operation(client);
    } finally {
      client.close();
    }
  }

  async #list(input: z.infer<typeof listInputSchema>): Promise<ResetMcpCallResult> {
    const timeZone = input.time_zone ?? defaultTimeZone();
    try {
      const execution = await this.#withClient((client) => runList(client));
      return executionResult("list_reset_credits", execution, timeZone, { timeZone });
    } catch (error) {
      return executionResult("list_reset_credits", applicationFailure("list", error), timeZone, {
        timeZone,
      });
    }
  }

  async #checkRemoteSetup(
    input: z.infer<typeof listInputSchema>,
    context: ResetMcpCallContext,
  ): Promise<ResetMcpCallResult> {
    const timeZone = input.time_zone ?? defaultTimeZone();
    const [doctorResult, journalResult] = await Promise.allSettled([
      this.#withClient((client) => runDoctor(client)),
      this.#inspectStateDirectory(),
    ]);
    const execution =
      doctorResult.status === "fulfilled"
        ? doctorResult.value
        : applicationFailure("doctor", doctorResult.reason);
    const journal: AttemptStateDirectoryInspection =
      journalResult.status === "fulfilled"
        ? journalResult.value
        : {
            ready: false,
            state: "invalid",
            message: redactText(
              journalResult.reason instanceof Error
                ? journalResult.reason.message
                : String(journalResult.reason),
            ),
          };

    const requiredDiagnostics = [
      "app-server",
      "account",
      "rate-limits",
      "reset-credit-details",
      "redemption-account",
    ] as const;
    const checks = Object.fromEntries(
      requiredDiagnostics.map((name) => [
        name,
        execution.envelope.diagnostics.find((diagnostic) => diagnostic.name === name)?.ok === true,
      ]),
    );
    checks["journal-state"] = journal.ready;
    const hostReady = requiredDiagnostics.every((name) => checks[name]) && journal.ready;
    const formElicitation = context.clientCapabilities.formElicitation;
    const ready = execution.exitCode === EXIT_CODE.success && hostReady && formElicitation;
    const readiness = {
      ready,
      hostReady,
      protocolVersion: context.clientCapabilities.protocolVersion,
      formElicitation,
      checks,
      journal,
    };
    const result = executionResult("check_remote_reset_setup", execution, timeZone, {
      timeZone,
      readiness,
    });
    result.content[0] = {
      type: "text",
      text: [
        `Remote reset setup: ${ready ? "READY" : "NOT READY"}`,
        `MCP protocol: ${safeTerminalField(context.clientCapabilities.protocolVersion ?? "unavailable")}`,
        `Bound confirmation form: ${formElicitation ? "available" : "unavailable"}`,
        `Local journal: ${journal.ready ? "available" : "unavailable"} (${safeTerminalField(journal.message, 1_024)})`,
        executionText(remoteEnvelope(execution), timeZone),
        "This check was read-only. No reset attempt was prepared and no credit was consumed.",
      ].join("\n"),
    };
    return result;
  }

  async #prepare(input: z.infer<typeof prepareInputSchema>): Promise<ResetMcpCallResult> {
    const timeZone = input.time_zone ?? defaultTimeZone();
    let execution: CommandExecution;
    try {
      execution = await this.#withClient((client) =>
        runPrepareRedemption(client, this.#store, {
          selector: selectorFromInput(input),
          timeZone,
          confirmationMode: "codex-remote",
          now: this.#now,
        }),
      );
    } catch (error) {
      execution = applicationFailure("prepare", error);
    }
    const attemptId = execution.envelope.redemption?.attemptId;
    if (attemptId == null || execution.exitCode !== EXIT_CODE.success) {
      return executionResult("prepare_reset_redemption", execution, timeZone);
    }
    try {
      const attempt = await this.#store.read(attemptId);
      return executionResult("prepare_reset_redemption", execution, timeZone, {
        approval: approvalBinding(attempt),
        nextTool: "redeem_prepared_reset",
      });
    } catch (error) {
      return executionResult(
        "prepare_reset_redemption",
        applicationFailure("prepare", error),
        timeZone,
      );
    }
  }

  async #getAttempt(input: z.infer<typeof attemptInputSchema>): Promise<ResetMcpCallResult> {
    try {
      const attempt = await this.#store.read(input.attempt_id);
      const view = publicAttempt(attempt, this.#now());
      return {
        content: [
          {
            type: "text",
            text: [
              `Attempt: ${attempt.attemptId}`,
              `State: ${attempt.state}`,
              `Account fingerprint: ${attempt.accountFingerprint.slice(0, 16)}`,
              `Credit ID: ${formatCreditId(attempt.target.id)}`,
              `Expires: ${formatTimestamp(attempt.target.expiresAt, attempt.timeZone)}`,
              `Next action: ${String(view.nextAction)}`,
              "No consume request was sent and the journal was not changed.",
            ].join("\n"),
          },
        ],
        structuredContent: {
          schemaVersion: 1,
          tool: "get_redemption_attempt",
          attempt: view,
        },
      };
    } catch (error) {
      const execution = applicationFailure("recover", error);
      return executionResult("get_redemption_attempt", execution, defaultTimeZone());
    }
  }

  async #redeem(
    binding: ApprovalBinding,
    context: ResetMcpCallContext,
  ): Promise<ResetMcpCallResult> {
    let prepared: RedemptionAttempt;
    try {
      prepared = await this.#store.read(binding.attempt_id);
    } catch (error) {
      return executionResult(
        "redeem_prepared_reset",
        applicationFailure("commit", error),
        defaultTimeZone(),
      );
    }
    if (!bindingMatches(prepared, binding)) {
      return executionResult(
        "redeem_prepared_reset",
        bindingFailure("commit", prepared),
        prepared.timeZone,
        { approval: approvalBinding(prepared) },
      );
    }

    let confirmed = false;
    let execution: CommandExecution;
    try {
      execution = await this.#withClient((client) =>
        runCommitRedemption(client, this.#store, {
          attemptId: binding.attempt_id,
          confirm: async (attempt) => {
            const current = attempt as RedemptionAttempt;
            if (!bindingMatches(current, binding) || context.signal.aborted) {
              return false;
            }
            const confirmation = confirmationMessage(current, "redeem");
            confirmed = await context.requestConfirmation({
              kind: "redeem",
              ...confirmation,
              expiresAt: current.expiresAt,
            });
            return confirmed && !context.signal.aborted;
          },
          authorizationStillValid: () => confirmed && !context.signal.aborted,
          ...(this.#verificationDelaysMs === undefined
            ? {}
            : { verificationDelaysMs: this.#verificationDelaysMs }),
          ...(this.#sleep === undefined ? {} : { sleep: this.#sleep }),
          now: this.#now,
        }),
      );
    } catch (error) {
      execution = applicationFailure("commit", error);
    }
    let latest = prepared;
    try {
      latest = await this.#store.read(binding.attempt_id);
    } catch {
      // The sanitized execution already carries the authoritative journal failure.
    }
    return executionResult("redeem_prepared_reset", execution, prepared.timeZone, {
      approval: approvalBinding(latest),
      nextTool:
        latest.state === "sending" || latest.state === "outcome-unknown"
          ? "recover_reset_redemption"
          : null,
    });
  }

  async #recover(
    binding: ApprovalBinding,
    context: ResetMcpCallContext,
  ): Promise<ResetMcpCallResult> {
    let prepared: RedemptionAttempt;
    try {
      prepared = await this.#store.read(binding.attempt_id);
    } catch (error) {
      return executionResult(
        "recover_reset_redemption",
        applicationFailure("recover", error),
        defaultTimeZone(),
      );
    }
    if (!bindingMatches(prepared, binding)) {
      return executionResult(
        "recover_reset_redemption",
        bindingFailure("recover", prepared),
        prepared.timeZone,
        { approval: approvalBinding(prepared) },
      );
    }

    let confirmed = false;
    let execution: CommandExecution;
    try {
      execution = await this.#withClient((client) =>
        runRecoverRedemption(client, this.#store, {
          attemptId: binding.attempt_id,
          confirm: async (attempt) => {
            const current = attempt as RedemptionAttempt;
            if (!bindingMatches(current, binding) || context.signal.aborted) {
              return false;
            }
            const confirmation = confirmationMessage(current, "recover");
            confirmed = await context.requestConfirmation({
              kind: "recover",
              ...confirmation,
              expiresAt: current.createdAt + RECOVERY_ATTEMPT_TTL_MS,
            });
            return confirmed && !context.signal.aborted;
          },
          confirmCloseUnknown: async (attempt) => {
            const current = attempt as RedemptionAttempt;
            if (!bindingMatches(current, binding) || context.signal.aborted) {
              return false;
            }
            const confirmation = confirmationMessage(current, "close-unknown");
            confirmed = await context.requestConfirmation({
              kind: "close-unknown",
              ...confirmation,
              expiresAt: null,
            });
            return confirmed && !context.signal.aborted;
          },
          authorizationStillValid: () => confirmed && !context.signal.aborted,
          ...(this.#verificationDelaysMs === undefined
            ? {}
            : { verificationDelaysMs: this.#verificationDelaysMs }),
          ...(this.#sleep === undefined ? {} : { sleep: this.#sleep }),
          now: this.#now,
        }),
      );
    } catch (error) {
      execution = applicationFailure("recover", error);
    }
    let latest = prepared;
    try {
      latest = await this.#store.read(binding.attempt_id);
    } catch {
      // The sanitized execution already carries the authoritative journal failure.
    }
    return executionResult("recover_reset_redemption", execution, prepared.timeZone, {
      approval: approvalBinding(latest),
      nextTool:
        latest.state === "sending" || latest.state === "outcome-unknown"
          ? "recover_reset_redemption"
          : null,
    });
  }
}

export function envelopeFromMcpResult(result: ResetMcpCallResult): CommandEnvelope | null {
  const execution = result.structuredContent.execution;
  if (execution == null || typeof execution !== "object") {
    return null;
  }
  return execution as CommandEnvelope;
}
