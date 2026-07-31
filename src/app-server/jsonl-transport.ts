import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { redactText, safeTerminalField } from "../security/redact.js";
import { AppServerError } from "./errors.js";

const MAX_PROTOCOL_LINE_CHARACTERS = 4 * 1_024 * 1_024;

type RpcId = number | string;

interface PendingRequest {
  method: string;
  sent: boolean;
  timer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: AppServerError) => void;
}

interface JsonObject {
  [key: string]: unknown;
}

export interface JsonlTransportOptions {
  timeoutMs: number;
  onDiagnostic?: (message: string) => void;
  onNotification?: (method: string, params: unknown) => void;
}

function isObject(value: unknown): value is JsonObject {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isRpcId(value: unknown): value is RpcId {
  return typeof value === "number" || typeof value === "string";
}

export class JsonlTransport {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #timeoutMs: number;
  readonly #onDiagnostic: (message: string) => void;
  readonly #onNotification: (method: string, params: unknown) => void;
  readonly #stdoutReader: ReadlineInterface;
  readonly #stderrReader: ReadlineInterface;
  readonly #pending = new Map<RpcId, PendingRequest>();
  #nextId = 0;
  #closed = false;
  #exitDescription: string | null = null;

  constructor(child: ChildProcessWithoutNullStreams, options: JsonlTransportOptions) {
    this.#child = child;
    this.#timeoutMs = options.timeoutMs;
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined);
    this.#onNotification = options.onNotification ?? (() => undefined);

    this.#stdoutReader = createInterface({ input: child.stdout });
    this.#stderrReader = createInterface({ input: child.stderr });
    this.#stdoutReader.on("line", (line) => this.#handleLine(line));
    this.#stderrReader.on("line", (line) => this.#diagnostic(line));

    child.once("error", (error) => {
      this.#failAll("spawn", `App Server process error: ${redactText(error.message)}`);
    });
    child.stdin.on("error", (error) => {
      if (!this.#closed) {
        this.#failAll("closed", `App Server stdin failed: ${redactText(error.message)}`);
      }
    });
    child.once("exit", (code, signal) => {
      this.#exitDescription = signal == null ? `code ${String(code)}` : `signal ${signal}`;
    });
    child.once("close", () => {
      if (!this.#closed) {
        this.#failAll(
          "closed",
          `App Server closed${this.#exitDescription == null ? "" : ` with ${this.#exitDescription}`}.`,
        );
      }
    });
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new AppServerError("closed", "App Server transport is closed."));
    }

    const id = this.#nextId++;
    const message: JsonObject = { method, id };
    if (params !== undefined) {
      message.params = params;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.#pending.get(id);
        if (pending == null) {
          return;
        }
        this.#pending.delete(id);
        reject(
          new AppServerError("timeout", `${method} timed out after ${this.#timeoutMs} ms.`, {
            requestSent: pending.sent,
          }),
        );
      }, this.#timeoutMs);
      timer.unref();

      const pending: PendingRequest = {
        method,
        sent: false,
        timer,
        resolve,
        reject,
      };
      this.#pending.set(id, pending);

      try {
        this.#child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
          if (error == null) {
            return;
          }
          const active = this.#pending.get(id);
          if (active == null) {
            return;
          }
          clearTimeout(active.timer);
          this.#pending.delete(id);
          active.reject(
            new AppServerError("closed", `Could not write ${method} to App Server.`, {
              requestSent: true,
              cause: error,
            }),
          );
        });
        pending.sent = true;
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(
          new AppServerError("closed", `Could not write ${method} to App Server.`, {
            requestSent: false,
            cause: error,
          }),
        );
      }
    });
  }

  async notify(method: string, params: unknown = {}): Promise<void> {
    if (this.#closed) {
      throw new AppServerError("closed", "App Server transport is closed.");
    }
    await new Promise<void>((resolve, reject) => {
      try {
        this.#child.stdin.write(`${JSON.stringify({ method, params })}\n`, (error) => {
          if (error == null) {
            resolve();
          } else {
            reject(
              new AppServerError("closed", `Could not write ${method} to App Server.`, {
                requestSent: true,
                cause: error,
              }),
            );
          }
        });
      } catch (error) {
        reject(
          new AppServerError("closed", `Could not write ${method} to App Server.`, {
            requestSent: false,
            cause: error,
          }),
        );
      }
    });
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#failPendingAsClosed();
    this.#stdoutReader.close();
    this.#stderrReader.close();
    this.#child.stdin.end();
    if (this.#child.exitCode == null && this.#child.signalCode == null) {
      const killTimer = setTimeout(() => {
        if (this.#child.exitCode == null && this.#child.signalCode == null) {
          this.#child.kill("SIGTERM");
        }
      }, 500);
      killTimer.unref();
      const forceTimer = setTimeout(() => {
        if (this.#child.exitCode == null && this.#child.signalCode == null) {
          this.#child.kill("SIGKILL");
        }
      }, 1_500);
      forceTimer.unref();
      this.#child.once("exit", () => {
        clearTimeout(killTimer);
        clearTimeout(forceTimer);
      });
    }
  }

  #handleLine(line: string): void {
    if (line.length > MAX_PROTOCOL_LINE_CHARACTERS) {
      this.#diagnostic("Ignored an oversized App Server protocol line.");
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.#diagnostic(`Ignored non-JSON App Server stdout: ${line}`);
      return;
    }

    if (!isObject(message)) {
      this.#diagnostic("Ignored non-object App Server message.");
      return;
    }

    if (typeof message.method === "string" && isRpcId(message.id)) {
      this.#respondUnsupportedServerRequest(message.id, message.method);
      return;
    }

    if (isRpcId(message.id)) {
      const pending = this.#pending.get(message.id);
      if (pending == null) {
        this.#diagnostic(`Ignored response for unknown request id ${String(message.id)}.`);
        return;
      }
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);

      if (isObject(message.error)) {
        const rpcCode = typeof message.error.code === "number" ? message.error.code : undefined;
        const rpcMessage =
          typeof message.error.message === "string"
            ? redactText(message.error.message)
            : "RPC error";
        pending.reject(
          new AppServerError("rpc", `${pending.method} failed: ${rpcMessage}`, {
            requestSent: true,
            ...(rpcCode === undefined ? {} : { rpcCode }),
          }),
        );
        return;
      }

      pending.resolve(message.result);
      return;
    }

    if (typeof message.method === "string") {
      this.#onNotification(message.method, message.params);
      return;
    }

    this.#diagnostic("Ignored App Server message without an id or method.");
  }

  #respondUnsupportedServerRequest(id: RpcId, method: string): void {
    this.#diagnostic(`Rejected unsupported App Server request ${method}.`);
    const response = {
      id,
      error: { code: -32601, message: `Client does not support server request ${method}.` },
    };
    try {
      this.#child.stdin.write(`${JSON.stringify(response)}\n`, (error) => {
        if (error != null) {
          this.#failAll("closed", "Could not respond to an App Server request.");
        }
      });
    } catch {
      this.#failAll("closed", "Could not respond to an App Server request.");
    }
  }

  #diagnostic(message: string): void {
    try {
      this.#onDiagnostic(safeTerminalField(message, 4_096));
    } catch {
      // A diagnostic sink must never break protocol processing.
    }
  }

  #failAll(kind: "spawn" | "closed", message: string): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(
        new AppServerError(kind, message, {
          requestSent: pending.sent,
        }),
      );
    }
    this.#pending.clear();
  }

  #failPendingAsClosed(): void {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(
        new AppServerError("closed", "App Server transport closed before responding.", {
          requestSent: pending.sent,
        }),
      );
    }
    this.#pending.clear();
  }
}
