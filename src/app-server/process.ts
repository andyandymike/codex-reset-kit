import type { ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import spawn from "cross-spawn";
import { hasControlCharacters } from "../security/redact.js";
import { AppServerError } from "./errors.js";

export interface AppServerLaunchOptions {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
}

export function spawnAppServer(options: AppServerLaunchOptions): ChildProcessWithoutNullStreams {
  const args = options.args ?? ["app-server", "--stdio"];

  if (options.command.trim().length === 0 || hasControlCharacters(options.command)) {
    throw new AppServerError("spawn", "The Codex executable path is invalid.");
  }
  const markedFakeFixture =
    options.env?.CODEX_RESET_FAKE_APP_SERVER === "1" &&
    path.resolve(options.command) === path.resolve(process.execPath) &&
    args.length === 1 &&
    path.basename(args[0] ?? "").toLowerCase() === "fake-app-server.mjs";
  if (process.env.CODEX_RESET_KIT_TEST_MODE === "1" && !markedFakeFixture) {
    throw new AppServerError(
      "spawn",
      "Test mode blocked an App Server process that was not explicitly marked as the fake fixture.",
    );
  }

  try {
    return spawn(options.command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      env: options.env ?? process.env,
    }) as ChildProcessWithoutNullStreams;
  } catch (error) {
    throw new AppServerError("spawn", `Could not start ${options.command}.`, { cause: error });
  }
}
