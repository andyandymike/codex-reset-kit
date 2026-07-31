export type AppServerErrorKind = "spawn" | "closed" | "timeout" | "protocol" | "rpc";

export class AppServerError extends Error {
  readonly kind: AppServerErrorKind;
  readonly requestSent: boolean;
  readonly rpcCode: number | null;

  constructor(
    kind: AppServerErrorKind,
    message: string,
    options: { requestSent?: boolean; rpcCode?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppServerError";
    this.kind = kind;
    this.requestSent = options.requestSent ?? false;
    this.rpcCode = options.rpcCode ?? null;
  }
}

export function isAppServerError(value: unknown): value is AppServerError {
  return value instanceof AppServerError;
}
