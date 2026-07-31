import { z } from "zod";
import type { RateLimitSnapshot } from "../domain/rate-limit.js";
import { AppServerError } from "./errors.js";
import { JsonlTransport } from "./jsonl-transport.js";
import { type AppServerLaunchOptions, spawnAppServer } from "./process.js";
import {
  type AccountSnapshot,
  parseAccountSnapshot,
  parseConsumeOutcome,
  parseRateLimitSnapshot,
} from "./schemas.js";

export interface ConsumeResetParams {
  idempotencyKey: string;
  creditId?: string;
}

export interface CodexAppServerClient {
  readAccount(): Promise<AccountSnapshot>;
  readRateLimits(): Promise<RateLimitSnapshot>;
  consumeResetCredit(params: ConsumeResetParams): Promise<string>;
  close(): void;
}

export interface ConnectAppServerOptions extends AppServerLaunchOptions {
  timeoutMs: number;
  clientVersion: string;
  onDiagnostic?: (message: string) => void;
}

class StdioCodexAppServerClient implements CodexAppServerClient {
  readonly #transport: JsonlTransport;

  constructor(transport: JsonlTransport) {
    this.#transport = transport;
  }

  async readAccount(): Promise<AccountSnapshot> {
    const value = await this.#transport.request("account/read", { refreshToken: false });
    return parse("account/read", value, parseAccountSnapshot);
  }

  async readRateLimits(): Promise<RateLimitSnapshot> {
    const value = await this.#transport.request("account/rateLimits/read");
    return parse("account/rateLimits/read", value, parseRateLimitSnapshot);
  }

  async consumeResetCredit(params: ConsumeResetParams): Promise<string> {
    const requestParams =
      params.creditId === undefined
        ? { idempotencyKey: params.idempotencyKey }
        : { idempotencyKey: params.idempotencyKey, creditId: params.creditId };
    const value = await this.#transport.request(
      "account/rateLimitResetCredit/consume",
      requestParams,
    );
    return parse("account/rateLimitResetCredit/consume", value, parseConsumeOutcome);
  }

  close(): void {
    this.#transport.close();
  }
}

function parse<T>(method: string, value: unknown, parser: (input: unknown) => T): T {
  try {
    return parser(value);
  } catch (error) {
    const detail = error instanceof z.ZodError ? z.prettifyError(error) : "Invalid response";
    throw new AppServerError("protocol", `${method} returned an incompatible response: ${detail}`, {
      requestSent: true,
      cause: error,
    });
  }
}

export async function connectAppServer(
  options: ConnectAppServerOptions,
): Promise<CodexAppServerClient> {
  const child = spawnAppServer(options);
  const transport = new JsonlTransport(child, {
    timeoutMs: options.timeoutMs,
    ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
  });

  try {
    await transport.request("initialize", {
      clientInfo: {
        name: "codex_reset_kit",
        title: "Codex Reset Kit",
        version: options.clientVersion,
      },
    });
    transport.notify("initialized", {});
    return new StdioCodexAppServerClient(transport);
  } catch (error) {
    transport.close();
    throw error;
  }
}
