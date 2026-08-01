import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { connectAppServer } from "../../src/app-server/client.js";
import { MemoryRedemptionAttemptStore } from "../../src/application/attempt-store.js";
import { ResetMcpStdioServer } from "../../src/mcp/stdio-server.js";
import { OBSERVED_AT_MS } from "../helpers.js";

const fixture = fileURLToPath(new URL("../fixtures/fake-app-server.mjs", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

interface JsonMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

class McpHarness {
  readonly input = new PassThrough();
  readonly messages: JsonMessage[] = [];
  readonly #waiters = new Set<() => void>();
  #buffer = "";

  readonly output = {
    write: (chunk: string | Uint8Array): boolean => {
      this.#buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      for (;;) {
        const newline = this.#buffer.indexOf("\n");
        if (newline < 0) {
          break;
        }
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        if (line.length > 0) {
          this.messages.push(JSON.parse(line) as JsonMessage);
          for (const wake of this.#waiters) {
            wake();
          }
        }
      }
      return true;
    },
  };

  send(message: Record<string, unknown>): void {
    this.input.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  async waitFor(predicate: (message: JsonMessage) => boolean): Promise<JsonMessage> {
    const existing = this.messages.find(predicate);
    if (existing != null) {
      return existing;
    }
    return await new Promise<JsonMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#waiters.delete(check);
        reject(new Error(`Timed out waiting for MCP output: ${JSON.stringify(this.messages)}`));
      }, 5_000);
      const check = (): void => {
        const match = this.messages.find(predicate);
        if (match == null) {
          return;
        }
        clearTimeout(timeout);
        this.#waiters.delete(check);
        resolve(match);
      };
      this.#waiters.add(check);
    });
  }
}

function resultContent(message: JsonMessage): Record<string, unknown> {
  const result = message.result;
  if (result == null) {
    throw new Error("MCP response has no result");
  }
  const structured = result.structuredContent;
  if (structured == null || typeof structured !== "object") {
    throw new Error("MCP response has no structuredContent");
  }
  return structured as Record<string, unknown>;
}

describe("Codex Reset Kit MCP stdio server", () => {
  it.each(["2025-11-25", "2025-06-18"])(
    "requires form elicitation and sends exactly once through the marked fake App Server (%s)",
    async (protocolVersion) => {
      const directory = await mkdtemp(path.join(tmpdir(), "codex-reset-mcp-test-"));
      temporaryDirectories.push(directory);
      const ledgerPath = path.join(directory, "ledger.json");
      const harness = new McpHarness();
      const diagnostics: string[] = [];
      const server = new ResetMcpStdioServer({
        input: harness.input,
        output: harness.output as never,
        diagnostics: { write: (value: string) => diagnostics.push(value) } as never,
        store: new MemoryRedemptionAttemptStore(),
        now: () => OBSERVED_AT_MS,
        verificationDelaysMs: [],
        connect: () =>
          connectAppServer({
            command: process.execPath,
            args: [fixture],
            env: {
              ...process.env,
              CODEX_RESET_FAKE_APP_SERVER: "1",
              CODEX_RESET_FAKE_SCENARIO: "happy",
              CODEX_RESET_FAKE_LEDGER: ledgerPath,
            },
            timeoutMs: 2_000,
            clientVersion: "mcp-test",
          }),
      });
      const running = server.start();

      harness.send({
        id: 1,
        method: "initialize",
        params: {
          protocolVersion,
          capabilities: {
            elicitation: protocolVersion === "2025-06-18" ? {} : { form: {} },
          },
          clientInfo: { name: "test-client", version: "1" },
        },
      });
      const initialized = await harness.waitFor((message) => message.id === 1);
      expect(initialized.result?.protocolVersion).toBe(protocolVersion);
      harness.send({ method: "notifications/initialized", params: {} });

      harness.send({ id: 2, method: "tools/list", params: {} });
      const listed = await harness.waitFor((message) => message.id === 2);
      const tools = listed.result?.tools as Array<Record<string, unknown>>;
      const redeemTool = tools.find((tool) => tool.name === "redeem_prepared_reset");
      expect(redeemTool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      });

      harness.send({
        id: 3,
        method: "tools/call",
        params: {
          name: "prepare_reset_redemption",
          arguments: { expires_on: "2026-08-01", time_zone: "UTC" },
        },
      });
      const preparedResponse = await harness.waitFor((message) => message.id === 3);
      const prepared = resultContent(preparedResponse);
      const rejectedBinding = prepared.approval as Record<string, unknown>;
      expect(rejectedBinding).toMatchObject({ credit_id: "fake-credit-1" });
      expect(existsSync(ledgerPath)).toBe(false);

      harness.send({
        id: 4,
        method: "tools/call",
        params: { name: "redeem_prepared_reset", arguments: rejectedBinding },
      });
      const rejectedElicitation = await harness.waitFor(
        (message) => message.method === "elicitation/create",
      );
      expect(existsSync(ledgerPath)).toBe(false);
      harness.send({
        id: rejectedElicitation.id,
        result: { action: "accept", content: { confirmation: "REDEEM WRONG" } },
      });
      const rejectedResponse = await harness.waitFor((message) => message.id === 4);
      const rejectedExecution = resultContent(rejectedResponse).execution as Record<
        string,
        unknown
      >;
      expect(rejectedExecution.ok).toBe(false);
      expect((rejectedExecution.redemption as Record<string, unknown>).state).toBe("stale");
      expect(existsSync(ledgerPath)).toBe(false);

      harness.send({
        id: 5,
        method: "tools/call",
        params: {
          name: "prepare_reset_redemption",
          arguments: { expires_on: "2026-08-01", time_zone: "UTC" },
        },
      });
      const cancellationPrepared = resultContent(
        await harness.waitFor((message) => message.id === 5),
      );
      const cancelledBinding = cancellationPrepared.approval as Record<string, unknown>;

      harness.send({
        id: 6,
        method: "tools/call",
        params: { name: "redeem_prepared_reset", arguments: cancelledBinding },
      });
      const cancelledElicitation = await harness.waitFor(
        (message) =>
          message.method === "elicitation/create" && message.id !== rejectedElicitation.id,
      );
      expect(existsSync(ledgerPath)).toBe(false);
      harness.send({ method: "notifications/cancelled", params: { requestId: 6 } });
      const cancelledResponse = await harness.waitFor((message) => message.id === 6);
      const cancelledExecution = resultContent(cancelledResponse).execution as Record<
        string,
        unknown
      >;
      expect(cancelledExecution.ok).toBe(false);
      expect((cancelledExecution.redemption as Record<string, unknown>).state).toBe("stale");
      expect(existsSync(ledgerPath)).toBe(false);

      harness.send({
        id: 7,
        method: "tools/call",
        params: {
          name: "prepare_reset_redemption",
          arguments: { expires_on: "2026-08-01", time_zone: "UTC" },
        },
      });
      const successPrepared = resultContent(await harness.waitFor((message) => message.id === 7));
      const successBinding = successPrepared.approval as Record<string, unknown>;

      harness.send({
        id: 8,
        method: "tools/call",
        params: { name: "redeem_prepared_reset", arguments: successBinding },
      });
      const elicitation = await harness.waitFor(
        (message) =>
          message.method === "elicitation/create" &&
          message.id !== rejectedElicitation.id &&
          message.id !== cancelledElicitation.id,
      );
      expect(existsSync(ledgerPath)).toBe(false);
      expect(elicitation.params?.mode).toBe(protocolVersion === "2025-11-25" ? "form" : undefined);
      const requestedSchema = elicitation.params?.requestedSchema as Record<string, unknown>;
      const properties = requestedSchema.properties as Record<string, Record<string, unknown>>;
      expect(typeof properties.confirmation?.pattern).toBe(
        protocolVersion === "2025-11-25" ? "string" : "undefined",
      );
      const description = String(properties.confirmation?.description);
      const challenge = /^Type (.+) exactly\.$/.exec(description)?.[1];
      expect(challenge).toMatch(/^REDEEM [0-9A-F]{8}$/);

      harness.send({
        id: elicitation.id,
        result: { action: "accept", content: { confirmation: challenge } },
      });
      const redeemedResponse = await harness.waitFor((message) => message.id === 8);
      const redeemed = resultContent(redeemedResponse);
      const execution = redeemed.execution as Record<string, unknown>;
      const verification = execution.verification as Record<string, unknown>;
      expect(execution.ok).toBe(true);
      expect(verification.status).toBe("verified");

      const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as Record<
        string,
        { params: string }
      >;
      expect(Object.keys(ledger)).toHaveLength(1);
      expect(Object.values(ledger)[0]?.params).toContain('"creditId":"fake-credit-1"');

      harness.send({
        id: 9,
        method: "tools/call",
        params: { name: "redeem_prepared_reset", arguments: successBinding },
      });
      await harness.waitFor((message) => message.id === 9);
      const repeatedLedger = JSON.parse(await readFile(ledgerPath, "utf8")) as Record<
        string,
        unknown
      >;
      expect(Object.keys(repeatedLedger)).toHaveLength(1);
      expect(diagnostics).toEqual([]);

      harness.input.end();
      await running;
    },
  );

  it.each([
    { label: "omits elicitation", protocolVersion: "2025-11-25", capabilities: {} },
    {
      label: "advertises URL-only elicitation",
      protocolVersion: "2025-11-25",
      capabilities: { elicitation: { url: {} } },
    },
    {
      label: "uses a pre-elicitation protocol",
      protocolVersion: "2025-03-26",
      capabilities: { elicitation: {} },
    },
  ])(
    "refuses destructive calls when the client $label",
    async ({ protocolVersion, capabilities }) => {
      const harness = new McpHarness();
      let connections = 0;
      const server = new ResetMcpStdioServer({
        input: harness.input,
        output: harness.output as never,
        diagnostics: { write: () => true } as never,
        connect: async () => {
          connections += 1;
          throw new Error("must not connect");
        },
      });
      const running = server.start();
      harness.send({
        id: 1,
        method: "initialize",
        params: {
          protocolVersion,
          capabilities,
          clientInfo: { name: "test-client", version: "1" },
        },
      });
      await harness.waitFor((message) => message.id === 1);
      harness.send({ method: "notifications/initialized", params: {} });
      harness.send({
        id: 2,
        method: "tools/call",
        params: {
          name: "redeem_prepared_reset",
          arguments: {
            attempt_id: "8ae96ff3-3425-4f4c-8772-b6fd61502868",
            account_fingerprint: "0123456789abcdef",
            credit_id: "credit-1",
            expires_at: 1,
            confirmation_expires_at: 1,
          },
        },
      });
      const response = await harness.waitFor((message) => message.id === 2);
      expect(response.result?.isError).toBe(true);
      expect(connections).toBe(0);
      harness.input.end();
      await running;
    },
  );
});
