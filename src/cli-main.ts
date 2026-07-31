import type { CodexAppServerClient } from "./app-server/client.js";
import { connectAppServer } from "./app-server/client.js";
import { isAppServerError } from "./app-server/errors.js";
import {
  AttemptStoreError,
  FileRedemptionAttemptStore,
  type RedemptionAttemptStore,
} from "./application/attempt-store.js";
import { runDoctor } from "./application/doctor.js";
import { runList } from "./application/list.js";
import {
  type CommandExecution,
  type CommandName,
  createEnvelope,
  EXIT_CODE,
  fail,
} from "./application/output.js";
import {
  type CommitRedemptionOptions,
  type RecoverRedemptionOptions,
  runCommitRedemption,
  runPrepareRedemption,
  runRecoverRedemption,
  runRedeem,
} from "./application/redeem.js";
import { CliArgumentError, HELP_TEXT, type ParsedCommand, parseCliArgs } from "./cli-options.js";
import { renderJson } from "./presentation/json.js";
import {
  confirmCloseUnknown,
  confirmPreparedRedemption,
  confirmRecovery,
  renderTerminal,
} from "./presentation/terminal.js";
import { redactText } from "./security/redact.js";

const VERSION = "0.1.0";

export interface CliDependencies {
  connect?: (command: ParsedCommand) => Promise<CodexAppServerClient>;
  store?: RedemptionAttemptStore;
  confirmPrepared?: CommitRedemptionOptions["confirm"];
  confirmRecovery?: RecoverRedemptionOptions["confirm"];
  confirmCloseUnknown?: RecoverRedemptionOptions["confirmCloseUnknown"];
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
}

function commandName(command: ParsedCommand): CommandName {
  return command.command === "help" ? "doctor" : command.command;
}

function renderExecution(
  execution: CommandExecution,
  command: ParsedCommand,
  stdout: Pick<NodeJS.WriteStream, "write">,
  stderr: Pick<NodeJS.WriteStream, "write">,
): void {
  if (command.common.json) {
    stdout.write(`${renderJson(execution.envelope)}\n`);
    return;
  }

  const rendered = renderTerminal(execution.envelope, command.common.timeZone);
  const target = execution.envelope.ok ? stdout : stderr;
  if (rendered.length > 0) {
    target.write(`${rendered}\n`);
  }
}

function executionFailure(command: ParsedCommand, error: unknown): CommandExecution {
  const envelope = createEnvelope(commandName(command));
  const message = redactText(error instanceof Error ? error.message : String(error));
  if (error instanceof AttemptStoreError) {
    return fail(envelope, EXIT_CODE.attempt, `attempt-${error.code}`, message);
  }
  return fail(
    envelope,
    EXIT_CODE.appServer,
    isAppServerError(error) ? `app-server-${error.kind}` : "application-error",
    message,
  );
}

export async function runCli(args: string[], dependencies: CliDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  let command: ParsedCommand;

  try {
    command = parseCliArgs(args);
  } catch (error) {
    const message = redactText(error instanceof CliArgumentError ? error.message : String(error));
    if (args.includes("--json")) {
      const requested = args[0];
      const supported = new Set(["list", "doctor", "prepare", "redeem", "commit", "recover"]);
      const name = (supported.has(requested ?? "") ? requested : "doctor") as CommandName;
      const execution = fail(
        createEnvelope(name),
        EXIT_CODE.arguments,
        "invalid-arguments",
        message,
      );
      stdout.write(`${renderJson(execution.envelope)}\n`);
    } else {
      stderr.write(`Error: ${message}\n\n${HELP_TEXT}`);
    }
    return EXIT_CODE.arguments;
  }

  if (command.command === "help") {
    stdout.write(HELP_TEXT);
    return EXIT_CODE.success;
  }

  const store =
    dependencies.store ??
    (command.command === "list" || command.command === "doctor"
      ? null
      : new FileRedemptionAttemptStore());
  let client: CodexAppServerClient | null = null;
  try {
    client =
      dependencies.connect == null
        ? await connectAppServer({
            command: command.common.codexBin,
            timeoutMs: command.common.timeoutMs,
            clientVersion: VERSION,
            ...(command.common.verbose
              ? {
                  onDiagnostic: (message: string) =>
                    stderr.write(`[codex app-server] ${message}\n`),
                }
              : {}),
          })
        : await dependencies.connect(command);

    let execution: CommandExecution;
    if (command.command === "list") {
      execution = await runList(client);
    } else if (command.command === "doctor") {
      execution = await runDoctor(client);
    } else if (command.command === "prepare") {
      if (store == null) {
        throw new Error("The prepare command requires a redemption journal store.");
      }
      execution = await runPrepareRedemption(client, store, {
        selector: command.selector,
        timeZone: command.common.timeZone,
      });
    } else if (command.command === "redeem") {
      if (store == null) {
        throw new Error("The redeem command requires a redemption journal store.");
      }
      execution = await runRedeem(client, store, {
        selector: command.selector,
        timeZone: command.common.timeZone,
        confirm: dependencies.confirmPrepared ?? confirmPreparedRedemption,
      });
    } else if (command.command === "commit") {
      if (store == null) {
        throw new Error("The commit command requires a redemption journal store.");
      }
      execution = await runCommitRedemption(client, store, {
        attemptId: command.attemptId,
        confirm: dependencies.confirmPrepared ?? confirmPreparedRedemption,
      });
    } else if (command.command === "recover") {
      if (store == null) {
        throw new Error("The recover command requires a redemption journal store.");
      }
      execution = await runRecoverRedemption(client, store, {
        attemptId: command.attemptId,
        confirm: dependencies.confirmRecovery ?? confirmRecovery,
        confirmCloseUnknown: dependencies.confirmCloseUnknown ?? confirmCloseUnknown,
      });
    } else {
      throw new Error(`Unhandled command: ${String(command.command)}`);
    }

    renderExecution(execution, command, stdout, stderr);
    return execution.exitCode;
  } catch (error) {
    const execution = executionFailure(command, error);
    renderExecution(execution, command, stdout, stderr);
    return execution.exitCode;
  } finally {
    client?.close();
  }
}
