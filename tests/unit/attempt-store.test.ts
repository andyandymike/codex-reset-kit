import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AttemptStoreError,
  defaultAttemptStateDirectory,
  FileRedemptionAttemptStore,
} from "../../src/application/attempt-store.js";
import { redemptionAttempt } from "../helpers.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function temporaryStore(): Promise<{
  root: string;
  store: FileRedemptionAttemptStore;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "codex-reset-kit-test-"));
  temporaryDirectories.push(root);
  return { root, store: new FileRedemptionAttemptStore(root) };
}

describe("FileRedemptionAttemptStore", () => {
  it("rejects a broad custom state root before changing its permissions", () => {
    const filesystemRoot = path.parse(process.cwd()).root;
    expect(() =>
      defaultAttemptStateDirectory({ CODEX_RESET_KIT_STATE_DIR: filesystemRoot }),
    ).toThrowError(AttemptStoreError);
  });

  it("durably appends revisions without replacing the previous record", async () => {
    const { root, store } = await temporaryStore();
    const created = await store.create(redemptionAttempt());
    const saved = await store.save({ ...created, state: "sending", approvedAt: Date.now() });
    expect(saved.revision).toBe(1);
    expect((await store.read(created.attemptId)).state).toBe("sending");

    const attemptDirectory = path.join(root, "attempts", created.attemptId);
    expect(await stat(path.join(attemptDirectory, "0000000000.json"))).toBeDefined();
    expect(await stat(path.join(attemptDirectory, "0000000001.json"))).toBeDefined();
  });

  it("rejects path traversal and arbitrary recovery identifiers", async () => {
    const { store } = await temporaryStore();
    await expect(store.read("../../auth.json")).rejects.toBeInstanceOf(AttemptStoreError);
  });

  it("detects conflicting revisions", async () => {
    const { store } = await temporaryStore();
    const original = await store.create(redemptionAttempt());
    await store.save({ ...original, state: "sending", approvedAt: Date.now() });
    await expect(store.save({ ...original, state: "stale" })).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("rejects a journal that extends its bound confirmation lifetime", async () => {
    const { store } = await temporaryStore();
    const attempt = await store.create(redemptionAttempt());
    await expect(
      store.save({ ...attempt, expiresAt: attempt.expiresAt + 1 }),
    ).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("rejects authority changes and illegal state jumps between revisions", async () => {
    const { store } = await temporaryStore();
    const attempt = await store.create(redemptionAttempt());
    await expect(
      store.save({
        ...attempt,
        state: "sending",
        approvedAt: Date.now(),
        idempotencyKey: "b15bc1c4-0d14-4b43-86bd-2dd0be76931f",
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      store.save({
        ...attempt,
        state: "completed",
        approvedAt: Date.now(),
        outcome: "reset",
      }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("validates the complete append-only chain instead of trusting only the latest file", async () => {
    const { root, store } = await temporaryStore();
    const created = await store.create(redemptionAttempt());
    await store.save({ ...created, state: "sending", approvedAt: Date.now() });
    const revision = path.join(root, "attempts", created.attemptId, "0000000001.json");
    const tampered = JSON.parse(await readFile(revision, "utf8"));
    tampered.target.id = "different-credit";
    await writeFile(revision, `${JSON.stringify(tampered)}\n`, "utf8");

    await expect(store.read(created.attemptId)).rejects.toMatchObject({ code: "invalid" });
  });

  it("rejects unsafe strings in a journal revision", async () => {
    const { root, store } = await temporaryStore();
    const created = await store.create(redemptionAttempt());
    const revision = path.join(root, "attempts", created.attemptId, "0000000000.json");
    const tampered = JSON.parse(await readFile(revision, "utf8"));
    tampered.target.id = "credit\u202eforged";
    await writeFile(revision, `${JSON.stringify(tampered)}\n`, "utf8");

    await expect(store.read(created.attemptId)).rejects.toMatchObject({ code: "invalid" });
  });

  it("allows only one in-flight operation per account", async () => {
    const { root, store } = await temporaryStore();
    const attempt = await store.create(redemptionAttempt());
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = store.withAccountLock(
      attempt.accountFingerprint,
      attempt.attemptId,
      () => barrier,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(
      store.withAccountLock(attempt.accountFingerprint, attempt.attemptId, async () => undefined),
    ).rejects.toMatchObject({ code: "locked" });
    release();
    await first;

    const lockDirectory = path.join(root, "locks", attempt.accountFingerprint);
    const revisions = (await readdir(lockDirectory)).sort();
    expect(revisions).toEqual(["0000000000.json", "0000000001.json"]);
    const released = JSON.parse(
      await readFile(path.join(lockDirectory, "0000000001.json"), "utf8"),
    );
    expect(released.active).toBeNull();
  });

  it("takes over a crashed lock only for the same nonterminal attempt", async () => {
    const { root, store } = await temporaryStore();
    const owner = await store.create(redemptionAttempt());
    const other = await store.create(redemptionAttempt());
    const lockDirectory = path.join(root, "locks", owner.accountFingerprint);
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(
      path.join(lockDirectory, "0000000000.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        revision: 0,
        accountFingerprint: owner.accountFingerprint,
        active: {
          attemptId: owner.attemptId,
          pid: 2_147_483_647,
          token: "8ae96ff3-3425-4f4c-8772-b6fd61502868",
          acquiredAt: Date.now(),
          operationActive: true,
        },
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    await expect(
      store.withAccountLock(other.accountFingerprint, other.attemptId, async () => undefined),
    ).rejects.toMatchObject({ code: "locked" });
    await expect(
      store.withAccountLock(owner.accountFingerprint, owner.attemptId, async () => "recovered"),
    ).resolves.toBe("recovered");
  });

  it("retains account ownership for uncertainty until the same attempt becomes terminal", async () => {
    const { store } = await temporaryStore();
    const owner = await store.create(redemptionAttempt());
    const other = await store.create(redemptionAttempt());

    await store.withAccountLock(owner.accountFingerprint, owner.attemptId, async () => {
      await store.save({
        ...owner,
        state: "sending",
        approvedAt: Date.now(),
      });
    });
    await expect(
      store.withAccountLock(other.accountFingerprint, other.attemptId, async () => undefined),
    ).rejects.toMatchObject({ code: "locked" });

    await store.withAccountLock(owner.accountFingerprint, owner.attemptId, async () => {
      const uncertain = await store.read(owner.attemptId);
      await store.save({ ...uncertain, state: "completed", outcome: "reset" });
    });
    await expect(
      store.withAccountLock(other.accountFingerprint, other.attemptId, async () => "allowed"),
    ).resolves.toBe("allowed");
  });
});
