import { randomUUID } from "node:crypto";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { safeTerminalField } from "../security/redact.js";
import {
  RESET_MCP_TOOLS,
  type RemoteConfirmationRequest,
  ResetMcpToolService,
  type ResetMcpToolServiceDependencies,
} from "./tool-service.js";

const SERVER_NAME = "codex-reset-kit";
const SERVER_VERSION = "0.1.0";
const LATEST_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);
const MAX_INPUT_LINE_BYTES = 1_048_576;
const MAX_ELICITATION_WAIT_MS = 5 * 60 * 1_000;

type RequestId = string | number;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: RequestId;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  removeAbortListener: () => void;
}

export interface ResetMcpStdioServerOptions extends ResetMcpToolServiceDependencies {
  input?: NodeJS.ReadableStream;
  output?: Pick<NodeJS.WriteStream, "write">;
  diagnostics?: Pick<NodeJS.WriteStream, "write">;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function hasRequestId(value: Record<string, unknown>): value is Record<string, unknown> & {
  id: RequestId;
} {
  return typeof value.id === "string" || typeof value.id === "number";
}

function requestKey(id: RequestId): string {
  return `${typeof id}:${String(id)}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function errorMessage(error: unknown): string {
  return safeTerminalField(error instanceof Error ? error.message : String(error), 2_048);
}

export class ResetMcpStdioServer {
  readonly #input: NodeJS.ReadableStream;
  readonly #output: Pick<NodeJS.WriteStream, "write">;
  readonly #diagnostics: Pick<NodeJS.WriteStream, "write">;
  readonly #tools: ResetMcpToolService;
  readonly #now: () => number;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #activeCalls = new Map<string, AbortController>();
  #reader: ReadlineInterface | null = null;
  #initializeReceived = false;
  #initialized = false;
  #negotiatedProtocolVersion: string | null = null;
  #clientSupportsFormElicitation = false;
  #activeToolCall = false;
  #closed = false;

  constructor(options: ResetMcpStdioServerOptions = {}) {
    this.#input = options.input ?? process.stdin;
    this.#output = options.output ?? process.stdout;
    this.#diagnostics = options.diagnostics ?? process.stderr;
    this.#now = options.now ?? Date.now;
    this.#tools = new ResetMcpToolService(options);
  }

  start(): Promise<void> {
    if (this.#reader != null) {
      throw new Error("The MCP stdio server has already started.");
    }
    this.#reader = createInterface({ input: this.#input, crlfDelay: Number.POSITIVE_INFINITY });
    return new Promise((resolve, reject) => {
      const reader = this.#reader as ReadlineInterface;
      const onInputError = (error: Error): void => {
        this.#diagnose(`MCP stdin failed: ${errorMessage(error)}`);
        this.#close(error);
        reject(error);
      };
      this.#input.once("error", onInputError);
      reader.on("line", (line) => {
        void this.#handleLine(line);
      });
      reader.once("close", () => {
        this.#input.removeListener("error", onInputError);
        this.#close(new Error("The MCP stdio connection closed."));
        resolve();
      });
    });
  }

  #diagnose(message: string): void {
    this.#diagnostics.write(`[codex-reset-kit:mcp] ${safeTerminalField(message, 2_048)}\n`);
  }

  #write(payload: Record<string, unknown>): void {
    if (this.#closed) {
      return;
    }
    this.#output.write(`${JSON.stringify(payload)}\n`);
  }

  #respond(id: RequestId, result: unknown): void {
    this.#write({ jsonrpc: "2.0", id, result });
  }

  #respondError(id: RequestId | null, code: number, message: string): void {
    this.#write({
      jsonrpc: "2.0",
      id,
      error: { code, message: safeTerminalField(message, 2_048) },
    });
  }

  async #handleLine(line: string): Promise<void> {
    if (Buffer.byteLength(line, "utf8") > MAX_INPUT_LINE_BYTES) {
      this.#respondError(null, -32600, "MCP message exceeds the one-megabyte limit.");
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.#respondError(null, -32700, "Invalid JSON.");
      return;
    }
    if (!isObject(value) || value.jsonrpc !== "2.0") {
      this.#respondError(null, -32600, "Invalid JSON-RPC message.");
      return;
    }

    if (typeof value.method !== "string") {
      if (hasRequestId(value)) {
        this.#handleResponse(value);
      }
      return;
    }

    if (!hasRequestId(value)) {
      this.#handleNotification(value as unknown as JsonRpcNotification);
      return;
    }

    await this.#handleRequest(value as unknown as JsonRpcRequest);
  }

  #handleResponse(message: Record<string, unknown> & { id: RequestId }): void {
    const key = requestKey(message.id);
    const pending = this.#pending.get(key);
    if (pending == null) {
      return;
    }
    this.#pending.delete(key);
    clearTimeout(pending.timer);
    pending.removeAbortListener();
    if (isObject(message.error)) {
      pending.reject(
        new Error(
          typeof message.error.message === "string"
            ? message.error.message
            : "The MCP client rejected the request.",
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }

  #handleNotification(notification: JsonRpcNotification): void {
    if (notification.method === "notifications/initialized") {
      if (this.#initializeReceived) {
        this.#initialized = true;
      }
      return;
    }
    if (notification.method !== "notifications/cancelled" || !isObject(notification.params)) {
      return;
    }
    const requestId = notification.params.requestId;
    if (typeof requestId !== "string" && typeof requestId !== "number") {
      return;
    }
    this.#activeCalls.get(requestKey(requestId))?.abort();
  }

  async #handleRequest(request: JsonRpcRequest): Promise<void> {
    try {
      if (request.method === "initialize") {
        this.#initialize(request);
        return;
      }
      if (request.method === "ping") {
        this.#respond(request.id, {});
        return;
      }
      if (!this.#initialized) {
        this.#respondError(request.id, -32002, "MCP server has not been initialized.");
        return;
      }
      if (request.method === "tools/list") {
        this.#respond(request.id, { tools: RESET_MCP_TOOLS });
        return;
      }
      if (request.method === "tools/call") {
        await this.#callTool(request);
        return;
      }
      this.#respondError(request.id, -32601, `Method not found: ${request.method}`);
    } catch (error) {
      this.#diagnose(`MCP request failed: ${errorMessage(error)}`);
      this.#respondError(request.id, -32603, "Internal MCP server error.");
    }
  }

  #initialize(request: JsonRpcRequest): void {
    if (this.#initializeReceived) {
      this.#respondError(request.id, -32600, "MCP server is already initialized.");
      return;
    }
    if (!isObject(request.params)) {
      this.#respondError(request.id, -32602, "initialize params must be an object.");
      return;
    }
    const requestedVersion = request.params.protocolVersion;
    const protocolVersion =
      typeof requestedVersion === "string" && SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
        ? requestedVersion
        : LATEST_PROTOCOL_VERSION;
    const capabilities = request.params.capabilities;
    const elicitation = isObject(capabilities) ? capabilities.elicitation : undefined;
    this.#initializeReceived = true;
    this.#negotiatedProtocolVersion = protocolVersion;
    this.#clientSupportsFormElicitation =
      (protocolVersion === "2025-11-25" || protocolVersion === "2025-06-18") &&
      isObject(elicitation) &&
      (Object.keys(elicitation).length === 0 || isObject(elicitation.form));
    this.#respond(request.id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions:
        "Run the read-only setup check before relying on phone access. Inspection never consumes a credit. Prepare first, then use only the exact returned approval binding. Redemption and recovery require host approval plus an in-client attempt-specific confirmation.",
    });
  }

  async #callTool(request: JsonRpcRequest): Promise<void> {
    if (!isObject(request.params) || typeof request.params.name !== "string") {
      this.#respondError(
        request.id,
        -32602,
        "tools/call requires a tool name and object arguments.",
      );
      return;
    }
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    if (!isObject(args)) {
      this.#respondError(request.id, -32602, "Tool arguments must be an object.");
      return;
    }
    if (
      (name === "redeem_prepared_reset" || name === "recover_reset_redemption") &&
      !this.#clientSupportsFormElicitation
    ) {
      this.#respond(request.id, {
        content: [
          {
            type: "text",
            text: "This MCP client does not advertise form elicitation. No consume request was sent and the attempt journal was not changed.",
          },
        ],
        structuredContent: {
          schemaVersion: 1,
          tool: name,
          error: { code: "confirmation-unavailable" },
        },
        isError: true,
      });
      return;
    }
    if (this.#activeToolCall) {
      this.#respond(request.id, {
        content: [
          {
            type: "text",
            text: "Another Codex Reset Kit tool call is still active. No action was taken.",
          },
        ],
        structuredContent: {
          schemaVersion: 1,
          tool: name,
          error: { code: "tool-call-busy" },
        },
        isError: true,
      });
      return;
    }

    this.#activeToolCall = true;
    const controller = new AbortController();
    const key = requestKey(request.id);
    this.#activeCalls.set(key, controller);
    try {
      const result = await this.#tools.call(name, args, {
        signal: controller.signal,
        clientCapabilities: {
          protocolVersion: this.#negotiatedProtocolVersion,
          formElicitation: this.#clientSupportsFormElicitation,
        },
        requestConfirmation: (confirmation) =>
          this.#requestConfirmation(confirmation, controller.signal),
      });
      this.#respond(request.id, result);
    } finally {
      controller.abort();
      this.#activeCalls.delete(key);
      this.#activeToolCall = false;
    }
  }

  async #requestConfirmation(
    request: RemoteConfirmationRequest,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!this.#clientSupportsFormElicitation || signal.aborted) {
      return false;
    }
    const now = this.#now();
    const remaining = request.expiresAt == null ? MAX_ELICITATION_WAIT_MS : request.expiresAt - now;
    if (remaining <= 0) {
      return false;
    }
    const timeoutMs = Math.max(1, Math.min(MAX_ELICITATION_WAIT_MS, remaining));
    let result: unknown;
    try {
      result = await this.#sendRequest(
        "elicitation/create",
        {
          ...(this.#negotiatedProtocolVersion === "2025-11-25" ? { mode: "form" } : {}),
          message: request.message,
          requestedSchema: {
            type: "object",
            properties: {
              confirmation: {
                type: "string",
                title: "Confirmation phrase",
                description: `Type ${request.challenge} exactly.`,
                minLength: request.challenge.length,
                maxLength: request.challenge.length,
                ...(this.#negotiatedProtocolVersion === "2025-11-25"
                  ? { pattern: `^${escapeRegex(request.challenge)}$` }
                  : {}),
              },
            },
            required: ["confirmation"],
          },
        },
        signal,
        timeoutMs,
      );
    } catch {
      return false;
    }
    return (
      isObject(result) &&
      result.action === "accept" &&
      isObject(result.content) &&
      result.content.confirmation === request.challenge &&
      !signal.aborted
    );
  }

  #sendRequest(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<unknown> {
    if (this.#closed || signal.aborted) {
      return Promise.reject(new Error("The MCP request was cancelled."));
    }
    const id = `${SERVER_NAME}:${randomUUID()}`;
    const key = requestKey(id);
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const pending = this.#pending.get(key);
        if (pending == null) {
          return;
        }
        this.#pending.delete(key);
        clearTimeout(pending.timer);
        reject(new Error("The MCP request was cancelled."));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        const pending = this.#pending.get(key);
        if (pending == null) {
          return;
        }
        this.#pending.delete(key);
        signal.removeEventListener("abort", onAbort);
        reject(new Error("The MCP confirmation timed out."));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(key, {
        resolve,
        reject,
        timer,
        removeAbortListener: () => signal.removeEventListener("abort", onAbort),
      });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  #close(error: Error): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const controller of this.#activeCalls.values()) {
      controller.abort();
    }
    this.#activeCalls.clear();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.removeAbortListener();
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
