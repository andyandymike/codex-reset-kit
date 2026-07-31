import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { link, lstat, mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  isTerminalAttemptState,
  PREPARED_ATTEMPT_TTL_MS,
  type RedemptionAttempt,
} from "../domain/redemption-attempt.js";
import { validateCalendarDate, validateTimeZone } from "../domain/select-credit.js";
import { hasControlCharacters } from "../security/redact.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_EPOCH_SECONDS = 253_402_300_799;
const MAX_EPOCH_MILLISECONDS = MAX_EPOCH_SECONDS * 1_000;
const MAX_ATTEMPT_REVISION_BYTES = 1_048_576;
const MAX_LOCK_REVISION_BYTES = 65_536;
const journalString = z.string().refine((value) => !hasControlCharacters(value), {
  message: "Journal strings must not contain control characters.",
});
const journalLabel = journalString.min(1).max(256);
const epochMilliseconds = z.number().int().min(0).max(MAX_EPOCH_MILLISECONDS);

const selectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("id"), id: journalString.min(1).max(1_024) }),
  z.object({ kind: z.literal("earliest") }),
  z.object({
    kind: z.literal("expires-on"),
    date: journalString.refine(validateCalendarDate, "The journaled calendar date is invalid."),
    timeZone: journalLabel.refine(validateTimeZone, "The journaled time zone is invalid."),
  }),
]);

const attemptSchema = z
  .object({
    schemaVersion: z.literal(1),
    attemptId: z.string().regex(UUID_PATTERN),
    revision: z.number().int().nonnegative(),
    state: z.enum([
      "prepared",
      "stale",
      "sending",
      "outcome-unknown",
      "closed-unknown",
      "completed",
      "rejected",
    ]),
    createdAt: epochMilliseconds,
    updatedAt: epochMilliseconds,
    expiresAt: epochMilliseconds,
    approvedAt: epochMilliseconds.nullable(),
    accountFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    planType: journalLabel.nullable(),
    requestedSelector: selectorSchema,
    target: z.object({
      id: journalString.min(1).max(1_024),
      resetType: z.literal("codexRateLimits"),
      expiresAt: z.number().int().min(0).max(MAX_EPOCH_SECONDS),
    }),
    timeZone: journalLabel.refine(validateTimeZone, "The journaled time zone is invalid."),
    snapshotDigest: z.string().regex(/^[0-9a-f]{64}$/),
    idempotencyKey: z.string().regex(UUID_PATTERN),
    baseline: z.object({
      observedAt: epochMilliseconds,
      availableCount: z.number().int().positive().max(1_000_000),
      windows: z
        .array(
          z.object({
            key: journalString.min(1).max(512),
            usedPercent: z.number().finite().min(0).max(100).nullable(),
            resetsAt: z.number().int().min(0).max(MAX_EPOCH_SECONDS).nullable(),
          }),
        )
        .max(1_024),
    }),
    outcome: z.enum(["reset", "alreadyRedeemed", "nothingToReset", "noCredit"]).nullable(),
    lastError: journalString.max(4_096).nullable(),
  })
  .superRefine((attempt, context) => {
    const invalid = (message: string): void => {
      context.addIssue({ code: "custom", message });
    };
    const expectedExpiry = Math.min(
      attempt.createdAt + PREPARED_ATTEMPT_TTL_MS,
      attempt.target.expiresAt * 1_000,
    );
    if (attempt.updatedAt < attempt.createdAt) {
      invalid("updatedAt precedes createdAt");
    }
    if (attempt.baseline.observedAt !== attempt.createdAt) {
      invalid("the baseline timestamp is not bound to creation");
    }
    if (attempt.expiresAt !== expectedExpiry || attempt.expiresAt <= attempt.createdAt) {
      invalid("the preparation expiry is not bound to the target and five-minute limit");
    }
    if (attempt.approvedAt != null && attempt.approvedAt < attempt.createdAt) {
      invalid("approvedAt precedes creation");
    }
    if ((attempt.state === "prepared" || attempt.state === "stale") && attempt.approvedAt != null) {
      invalid("an unsent attempt cannot contain an approval timestamp");
    }
    if (attempt.state !== "prepared" && attempt.state !== "stale" && attempt.approvedAt == null) {
      invalid("a sent attempt must contain its approval timestamp");
    }
    if (
      attempt.requestedSelector.kind === "id" &&
      attempt.requestedSelector.id !== attempt.target.id
    ) {
      invalid("the exact ID selector does not match the journaled target");
    }
    if (
      attempt.requestedSelector.kind === "expires-on" &&
      attempt.requestedSelector.timeZone !== attempt.timeZone
    ) {
      invalid("the selector timezone does not match the journaled timezone");
    }
    if (
      (attempt.state === "prepared" ||
        attempt.state === "stale" ||
        attempt.state === "sending" ||
        attempt.state === "outcome-unknown") &&
      attempt.outcome != null
    ) {
      invalid("a nonterminal or stale attempt cannot contain a definitive outcome");
    }
    if (
      attempt.state === "rejected" &&
      attempt.outcome !== "noCredit" &&
      attempt.outcome !== "nothingToReset"
    ) {
      invalid("a rejected attempt must contain a definitive non-consuming outcome");
    }
    if (
      attempt.state === "completed" &&
      attempt.outcome != null &&
      attempt.outcome !== "reset" &&
      attempt.outcome !== "alreadyRedeemed"
    ) {
      invalid("a completed attempt contains an incompatible outcome");
    }
    if (attempt.state === "closed-unknown" && attempt.outcome != null) {
      invalid("a closed unknown attempt cannot claim a definitive outcome");
    }
    const windowKeys = attempt.baseline.windows.map((window) => window.key);
    if (new Set(windowKeys).size !== windowKeys.length) {
      invalid("the baseline contains duplicate rate-limit window keys");
    }
  });

const accountLockRevisionSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  accountFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  active: z
    .object({
      attemptId: z.string().regex(UUID_PATTERN),
      pid: z.number().int().positive().nullable(),
      token: z.string().regex(UUID_PATTERN),
      acquiredAt: epochMilliseconds,
      operationActive: z.boolean(),
    })
    .superRefine((active, context) => {
      if (active.operationActive !== (active.pid != null)) {
        context.addIssue({
          code: "custom",
          message: "an active operation must have a PID and a retained owner must not",
        });
      }
    })
    .nullable(),
});

type AccountLockRevision = z.infer<typeof accountLockRevisionSchema>;

export type AttemptStoreErrorCode = "not-found" | "invalid" | "conflict" | "locked";

export class AttemptStoreError extends Error {
  readonly code: AttemptStoreErrorCode;

  constructor(code: AttemptStoreErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AttemptStoreError";
    this.code = code;
  }
}

export interface RedemptionAttemptStore {
  create(attempt: RedemptionAttempt): Promise<RedemptionAttempt>;
  read(attemptId: string): Promise<RedemptionAttempt>;
  save(attempt: RedemptionAttempt): Promise<RedemptionAttempt>;
  withAccountLock<T>(
    accountFingerprint: string,
    attemptId: string,
    operation: () => Promise<T>,
  ): Promise<T>;
}

function validateAttempt(value: unknown): RedemptionAttempt {
  const result = attemptSchema.safeParse(value);
  if (!result.success) {
    throw new AttemptStoreError(
      "invalid",
      "The redemption attempt journal is incompatible or corrupted.",
      {
        cause: result.error,
      },
    );
  }
  return result.data;
}

function validateAttemptId(attemptId: string): void {
  if (!UUID_PATTERN.test(attemptId)) {
    throw new AttemptStoreError("invalid", "The attempt ID is not a valid UUID.");
  }
}

function immutableAuthority(attempt: RedemptionAttempt): object {
  return {
    schemaVersion: attempt.schemaVersion,
    attemptId: attempt.attemptId,
    createdAt: attempt.createdAt,
    expiresAt: attempt.expiresAt,
    accountFingerprint: attempt.accountFingerprint,
    planType: attempt.planType,
    requestedSelector: attempt.requestedSelector,
    target: attempt.target,
    timeZone: attempt.timeZone,
    snapshotDigest: attempt.snapshotDigest,
    idempotencyKey: attempt.idempotencyKey,
    baseline: attempt.baseline,
  };
}

function validateAttemptTransition(current: RedemptionAttempt, proposed: RedemptionAttempt): void {
  if (!isDeepStrictEqual(immutableAuthority(current), immutableAuthority(proposed))) {
    throw new AttemptStoreError(
      "invalid",
      "Immutable redemption authority changed between journal revisions.",
    );
  }
  const allowed: Record<RedemptionAttempt["state"], ReadonlySet<RedemptionAttempt["state"]>> = {
    prepared: new Set(["sending", "stale"]),
    sending: new Set([
      "prepared",
      "sending",
      "outcome-unknown",
      "closed-unknown",
      "completed",
      "rejected",
    ]),
    "outcome-unknown": new Set([
      "sending",
      "outcome-unknown",
      "closed-unknown",
      "completed",
      "rejected",
    ]),
    stale: new Set(),
    "closed-unknown": new Set(),
    completed: new Set(),
    rejected: new Set(),
  };
  if (!allowed[current.state].has(proposed.state)) {
    throw new AttemptStoreError(
      "invalid",
      `Invalid redemption journal transition: ${current.state} -> ${proposed.state}.`,
    );
  }
  if (proposed.updatedAt < current.updatedAt) {
    throw new AttemptStoreError("invalid", "Redemption journal timestamps moved backwards.");
  }
  if (proposed.approvedAt != null && proposed.approvedAt > proposed.updatedAt) {
    throw new AttemptStoreError(
      "invalid",
      "The redemption approval timestamp follows its journal revision.",
    );
  }
  if (
    current.approvedAt != null &&
    proposed.state !== "prepared" &&
    proposed.approvedAt !== current.approvedAt
  ) {
    throw new AttemptStoreError(
      "invalid",
      "The original redemption approval timestamp changed between journal revisions.",
    );
  }
}

function validateInitialAttempt(attempt: RedemptionAttempt): void {
  if (
    attempt.revision !== 0 ||
    attempt.state !== "prepared" ||
    attempt.createdAt !== attempt.updatedAt ||
    attempt.approvedAt != null ||
    attempt.outcome != null
  ) {
    throw new AttemptStoreError(
      "invalid",
      "A redemption journal must begin with one unapproved prepared revision.",
    );
  }
}

function revisionName(revision: number): string {
  return `${revision.toString().padStart(10, "0")}.json`;
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is unsupported on some Windows filesystems. Each revision file is still fsynced.
  }
}

async function writeExclusive(file: string, value: unknown): Promise<void> {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, file);
  } finally {
    try {
      await unlink(temporary);
    } catch {
      // An unpublished or already-unlinked temporary file is never an authoritative revision.
    }
  }
  await syncDirectory(directory);
}

async function readPrivateJsonFile(
  file: string,
  maxBytes: number,
  label: string,
): Promise<unknown> {
  let metadata: Stats;
  try {
    metadata = await lstat(file);
  } catch (error) {
    throw new AttemptStoreError("invalid", `${label} cannot be inspected.`, { cause: error });
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new AttemptStoreError("invalid", `${label} is not a regular private file.`);
  }
  if (metadata.size > maxBytes) {
    throw new AttemptStoreError("invalid", `${label} is unexpectedly large.`);
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new AttemptStoreError("invalid", `${label} is accessible to other users.`);
  }
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new AttemptStoreError("invalid", `${label} cannot be read.`, { cause: error });
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new AttemptStoreError(
      "invalid",
      `The redemption state path is not a private directory: ${directory}`,
    );
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new AttemptStoreError(
      "invalid",
      `The redemption state directory is accessible to other users; restrict it to mode 0700: ${directory}`,
    );
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function defaultAttemptStateDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.CODEX_RESET_KIT_STATE_DIR?.trim();
  const resolved =
    configured == null || configured.length === 0
      ? path.join(homedir(), ".codex-reset-kit")
      : path.resolve(configured);
  const comparePath = (value: string): string =>
    process.platform === "win32" ? value.toLowerCase() : value;
  if (
    comparePath(resolved) === comparePath(path.parse(resolved).root) ||
    comparePath(resolved) === comparePath(path.resolve(homedir()))
  ) {
    throw new AttemptStoreError(
      "invalid",
      "CODEX_RESET_KIT_STATE_DIR must name a dedicated subdirectory, not a filesystem root or the home directory.",
    );
  }
  return resolved;
}

export class FileRedemptionAttemptStore implements RedemptionAttemptStore {
  readonly #root: string;

  constructor(root = defaultAttemptStateDirectory()) {
    this.#root = root;
  }

  async create(attempt: RedemptionAttempt): Promise<RedemptionAttempt> {
    const validated = validateAttempt(attempt);
    validateInitialAttempt(validated);
    validateAttemptId(validated.attemptId);
    await this.#ensureRoot();
    const directory = this.#attemptDirectory(validated.attemptId);
    try {
      await mkdir(directory, { mode: 0o700 });
      await writeExclusive(path.join(directory, revisionName(0)), validated);
      await syncDirectory(this.#attemptsDirectory());
      return validated;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new AttemptStoreError(
          "conflict",
          "A redemption attempt with this ID already exists.",
          {
            cause: error,
          },
        );
      }
      throw error;
    }
  }

  async read(attemptId: string): Promise<RedemptionAttempt> {
    validateAttemptId(attemptId);
    await this.#ensureRoot();
    const attemptDirectory = this.#attemptDirectory(attemptId);
    let entries: string[];
    try {
      const metadata = await lstat(attemptDirectory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new AttemptStoreError(
          "invalid",
          "The redemption attempt path is not a private directory.",
        );
      }
      if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
        throw new AttemptStoreError(
          "invalid",
          "The redemption attempt directory is accessible to other users.",
        );
      }
      entries = await readdir(attemptDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new AttemptStoreError("not-found", `Redemption attempt ${attemptId} was not found.`, {
          cause: error,
        });
      }
      throw error;
    }
    const revisions = entries.filter((entry) => /^\d{10}\.json$/.test(entry)).sort();
    if (revisions.length === 0) {
      throw new AttemptStoreError("invalid", "The redemption attempt journal has no revisions.");
    }
    let previous: RedemptionAttempt | null = null;
    for (let index = 0; index < revisions.length; index += 1) {
      const entry = revisions[index];
      if (entry !== revisionName(index)) {
        throw new AttemptStoreError(
          "invalid",
          "The redemption attempt journal has a missing or non-contiguous revision.",
        );
      }
      const value = await readPrivateJsonFile(
        path.join(attemptDirectory, entry),
        MAX_ATTEMPT_REVISION_BYTES,
        "The redemption attempt journal revision",
      );
      const attempt = validateAttempt(value);
      if (attempt.attemptId !== attemptId || attempt.revision !== index) {
        throw new AttemptStoreError(
          "invalid",
          "The redemption attempt revision does not match its path.",
        );
      }
      if (previous == null) {
        validateInitialAttempt(attempt);
      } else {
        validateAttemptTransition(previous, attempt);
      }
      previous = attempt;
    }
    if (previous == null) {
      throw new AttemptStoreError("invalid", "The redemption attempt journal has no revisions.");
    }
    return previous;
  }

  async save(attempt: RedemptionAttempt): Promise<RedemptionAttempt> {
    const validated = validateAttempt(attempt);
    const current = await this.read(validated.attemptId);
    if (current.revision !== validated.revision) {
      throw new AttemptStoreError("conflict", "The redemption attempt changed concurrently.");
    }
    const next = validateAttempt({
      ...validated,
      revision: validated.revision + 1,
      updatedAt: Math.max(Date.now(), current.updatedAt),
    });
    validateAttemptTransition(current, next);
    try {
      await writeExclusive(
        path.join(this.#attemptDirectory(attempt.attemptId), revisionName(next.revision)),
        next,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new AttemptStoreError("conflict", "The redemption attempt changed concurrently.", {
          cause: error,
        });
      }
      throw error;
    }
    return next;
  }

  async withAccountLock<T>(
    accountFingerprint: string,
    attemptId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!/^[0-9a-f]{64}$/.test(accountFingerprint)) {
      throw new AttemptStoreError("invalid", "The account fingerprint is invalid.");
    }
    validateAttemptId(attemptId);
    await this.#ensureRoot();
    await ensurePrivateDirectory(this.#accountLockDirectory(accountFingerprint));
    const lock = await this.#acquireAccountLock(accountFingerprint, attemptId);
    try {
      return await operation();
    } finally {
      let retainUncertainOwner = true;
      try {
        const latest = await this.read(attemptId);
        retainUncertainOwner = latest.state === "sending" || latest.state === "outcome-unknown";
      } catch {
        // An unreadable owner is retained so a different attempt cannot bypass uncertainty.
      }
      try {
        await this.#finishAccountLock(lock, retainUncertainOwner);
      } catch {
        // A failed release leaves a durable owner record and must not hide the operation result.
      }
    }
  }

  async #ensureRoot(): Promise<void> {
    await ensurePrivateDirectory(this.#root);
    await ensurePrivateDirectory(this.#attemptsDirectory());
    await ensurePrivateDirectory(this.#locksDirectory());
  }

  async #acquireAccountLock(
    accountFingerprint: string,
    attemptId: string,
  ): Promise<AccountLockRevision> {
    for (let tries = 0; tries < 32; tries += 1) {
      const current = await this.#readAccountLock(accountFingerprint);
      if (current?.active != null) {
        if (
          current.active.operationActive &&
          current.active.pid != null &&
          isProcessAlive(current.active.pid)
        ) {
          throw new AttemptStoreError(
            "locked",
            `Another redemption process is active for attempt ${current.active.attemptId}.`,
          );
        }
        if (current.active.attemptId !== attemptId) {
          let owner: RedemptionAttempt;
          try {
            owner = await this.read(current.active.attemptId);
          } catch (error) {
            throw new AttemptStoreError(
              "locked",
              `A crashed redemption process left an unverifiable account owner (${current.active.attemptId}).`,
              { cause: error },
            );
          }
          if (!isTerminalAttemptState(owner.state)) {
            throw new AttemptStoreError(
              "locked",
              `A previous uncertain attempt owns this account. Resume attempt ${owner.attemptId} instead of creating another send.`,
            );
          }
        }
      }

      const next: AccountLockRevision = {
        schemaVersion: 1,
        revision: (current?.revision ?? -1) + 1,
        accountFingerprint,
        active: {
          attemptId,
          pid: process.pid,
          token: randomUUID(),
          acquiredAt: Date.now(),
          operationActive: true,
        },
      };
      try {
        await writeExclusive(
          path.join(this.#accountLockDirectory(accountFingerprint), revisionName(next.revision)),
          next,
        );
        return next;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }
    }
    throw new AttemptStoreError(
      "locked",
      "The account lock changed too many times; no redemption request was sent.",
    );
  }

  async #finishAccountLock(
    owned: AccountLockRevision,
    retainUncertainOwner: boolean,
  ): Promise<void> {
    const ownedToken = owned.active?.token;
    if (ownedToken == null) {
      return;
    }
    for (let tries = 0; tries < 32; tries += 1) {
      const current = await this.#readAccountLock(owned.accountFingerprint);
      if (current == null || current.active?.token !== ownedToken) {
        return;
      }
      const next: AccountLockRevision = {
        schemaVersion: 1,
        revision: current.revision + 1,
        accountFingerprint: owned.accountFingerprint,
        active: retainUncertainOwner
          ? {
              ...current.active,
              pid: null,
              operationActive: false,
            }
          : null,
      };
      try {
        await writeExclusive(
          path.join(
            this.#accountLockDirectory(owned.accountFingerprint),
            revisionName(next.revision),
          ),
          next,
        );
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }
    }
    throw new AttemptStoreError("locked", "The account lock could not be released safely.");
  }

  async #readAccountLock(accountFingerprint: string): Promise<AccountLockRevision | null> {
    const directory = this.#accountLockDirectory(accountFingerprint);
    const entries = await readdir(directory);
    const revisions = entries.filter((entry) => /^\d{10}\.json$/.test(entry)).sort();
    for (let index = 0; index < revisions.length; index += 1) {
      if (revisions[index] !== revisionName(index)) {
        throw new AttemptStoreError(
          "invalid",
          "The account lock journal has a missing or non-contiguous revision.",
        );
      }
    }
    const latest = revisions.at(-1);
    if (latest == null) {
      return null;
    }
    const value = await readPrivateJsonFile(
      path.join(directory, latest),
      MAX_LOCK_REVISION_BYTES,
      "The account lock journal revision",
    );
    const parsed = accountLockRevisionSchema.safeParse(value);
    if (!parsed.success) {
      throw new AttemptStoreError("invalid", "The account lock journal is corrupted.", {
        cause: parsed.error,
      });
    }
    if (
      parsed.data.accountFingerprint !== accountFingerprint ||
      revisionName(parsed.data.revision) !== latest
    ) {
      throw new AttemptStoreError("invalid", "The account lock revision does not match its path.");
    }
    return parsed.data;
  }

  #attemptsDirectory(): string {
    return path.join(this.#root, "attempts");
  }

  #locksDirectory(): string {
    return path.join(this.#root, "locks");
  }

  #accountLockDirectory(accountFingerprint: string): string {
    return path.join(this.#locksDirectory(), accountFingerprint);
  }

  #attemptDirectory(attemptId: string): string {
    return path.join(this.#attemptsDirectory(), attemptId);
  }
}

export class MemoryRedemptionAttemptStore implements RedemptionAttemptStore {
  readonly #attempts = new Map<string, RedemptionAttempt>();
  readonly #locks = new Map<string, { attemptId: string; operationActive: boolean }>();

  async create(attempt: RedemptionAttempt): Promise<RedemptionAttempt> {
    const validated = validateAttempt(attempt);
    validateInitialAttempt(validated);
    if (this.#attempts.has(validated.attemptId)) {
      throw new AttemptStoreError("conflict", "A redemption attempt with this ID already exists.");
    }
    this.#attempts.set(validated.attemptId, structuredClone(validated));
    return structuredClone(validated);
  }

  async read(attemptId: string): Promise<RedemptionAttempt> {
    const attempt = this.#attempts.get(attemptId);
    if (attempt == null) {
      throw new AttemptStoreError("not-found", `Redemption attempt ${attemptId} was not found.`);
    }
    return structuredClone(attempt);
  }

  async save(attempt: RedemptionAttempt): Promise<RedemptionAttempt> {
    const validated = validateAttempt(attempt);
    const current = await this.read(validated.attemptId);
    if (current.revision !== validated.revision) {
      throw new AttemptStoreError("conflict", "The redemption attempt changed concurrently.");
    }
    const next = validateAttempt({
      ...structuredClone(validated),
      revision: validated.revision + 1,
      updatedAt: Math.max(Date.now(), current.updatedAt),
    });
    validateAttemptTransition(current, next);
    this.#attempts.set(next.attemptId, next);
    return structuredClone(next);
  }

  async withAccountLock<T>(
    accountFingerprint: string,
    attemptId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const current = this.#locks.get(accountFingerprint);
    if (current?.operationActive) {
      throw new AttemptStoreError(
        "locked",
        "Another redemption process is active for this account.",
      );
    }
    if (current != null && current.attemptId !== attemptId) {
      const owner = await this.read(current.attemptId);
      if (!isTerminalAttemptState(owner.state)) {
        throw new AttemptStoreError(
          "locked",
          `A previous uncertain attempt owns this account. Resume attempt ${owner.attemptId} instead of creating another send.`,
        );
      }
    }
    this.#locks.set(accountFingerprint, { attemptId, operationActive: true });
    try {
      return await operation();
    } finally {
      let retainUncertainOwner = true;
      try {
        const latest = await this.read(attemptId);
        retainUncertainOwner = latest.state === "sending" || latest.state === "outcome-unknown";
      } catch {
        // Retain an unreadable owner.
      }
      if (retainUncertainOwner) {
        this.#locks.set(accountFingerprint, { attemptId, operationActive: false });
      } else {
        this.#locks.delete(accountFingerprint);
      }
    }
  }
}
