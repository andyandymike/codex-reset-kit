import type { ChildProcessWithoutNullStreams } from "node:child_process";
import spawn from "cross-spawn";
import { AppServerError } from "./errors.js";

export interface AppServerLaunchOptions {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
}

export function spawnAppServer(options: AppServerLaunchOptions): ChildProcessWithoutNullStreams {
  const args = options.args ?? ["app-server", "--stdio"];

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
