import type { CodexAppServerClient } from "./app-server/client.js";
import { connectAppServer } from "./app-server/client.js";
import { isAppServerError } from "./app-server/errors.js";
import { runDoctor } from "./application/doctor.js";
import { runList } from "./application/list.js";
import {
  type CommandExecution,
  type CommandName,
  createEnvelope,
  EXIT_CODE,
  fail,
} from "./application/output.js";
import { runRedeem } from "./application/redeem.js";
import { CliArgumentError, HELP_TEXT, type ParsedCommand, parseCliArgs } from "./cli-options.js";
import { renderJson } from "./presentation/json.js";
import { confirmRedemption, renderTerminal } from "./presentation/terminal.js";
import { redactText } from "./security/redact.js";

const VERSION = "0.1.0";

export interface CliDependencies {
  connect?: (command: ParsedCommand) => Promise<CodexAppServerClient>;
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
  const target = execution.exitCode === 0 ? stdout : stderr;
  if (rendered.length > 0) {
    target.write(`${rendered}\n`);
  }
}

function connectionFailure(command: ParsedCommand, error: unknown): CommandExecution {
  const envelope = createEnvelope(commandName(command));
  const message = redactText(error instanceof Error ? error.message : String(error));
  return fail(
    envelope,
    EXIT_CODE.appServer,
    isAppServerError(error) ? `app-server-${error.kind}` : "app-server-error",
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
      const name: CommandName =
        requested === "list" || requested === "doctor" || requested === "redeem"
          ? requested
          : "doctor";
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

  let client: CodexAppServerClient | null = null;
  try {
    client =
      dependencies.connect == null
        ? await connectAppServer({
            command: command.common.codexBin,
            timeoutMs: command.common.timeoutMs,
            clientVersion: VERSION,
            onDiagnostic: (message) => stderr.write(`[codex app-server] ${message}\n`),
          })
        : await dependencies.connect(command);

    let execution: CommandExecution;
    if (command.command === "list") {
      execution = await runList(client);
    } else if (command.command === "doctor") {
      execution = await runDoctor(client);
    } else {
      execution = await runRedeem(client, {
        selector: command.selector,
        ...(command.idempotencyKey === undefined ? {} : { idempotencyKey: command.idempotencyKey }),
        confirm: command.yes
          ? async () => true
          : (selection, before) => confirmRedemption(selection, before, command.common.timeZone),
      });
    }

    renderExecution(execution, command, stdout, stderr);
    return execution.exitCode;
  } catch (error) {
    const execution = connectionFailure(command, error);
    renderExecution(execution, command, stdout, stderr);
    return execution.exitCode;
  } finally {
    client?.close();
  }
}
