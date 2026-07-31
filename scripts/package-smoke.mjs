import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(tmpdir(), "codex-reset-kit-package-"));
const packed = path.join(temporary, "packed");
const prefix = path.join(temporary, "prefix");
const npmCache = path.join(temporary, "npm-cache");

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_RESET_KIT_TEST_MODE: "1",
      npm_config_cache: npmCache,
    },
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${String(result.status)}):\n${String(result.error ?? "")}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return result.stdout;
}

const npmCli = process.env.npm_execpath;
if (npmCli == null || npmCli.length === 0) {
  throw new Error("package-smoke.mjs must be launched through an npm script.");
}

function runNpm(args) {
  return run(process.execPath, [npmCli, ...args]);
}

try {
  await mkdir(packed, { recursive: true });
  const packOutput = runNpm(["pack", "--json", "--ignore-scripts", "--pack-destination", packed]);
  const packResult = JSON.parse(packOutput)[0];
  if (packResult == null || typeof packResult.filename !== "string") {
    throw new Error("npm pack did not return a package filename.");
  }
  const names = new Set(packResult.files.map((entry) => entry.path));
  if ([...names].some((name) => name === "spec" || name.startsWith("spec/"))) {
    throw new Error("The private spec directory must never be included in the npm artifact.");
  }
  for (const required of [
    "THIRD_PARTY_NOTICES",
    "skills/redeem-codex-reset/LICENSE",
    "skills/redeem-codex-reset/THIRD_PARTY_NOTICES",
    "skills/redeem-codex-reset/scripts/codex-reset.mjs",
  ]) {
    if (!names.has(required)) {
      throw new Error(`Packed npm artifact is missing ${required}.`);
    }
  }

  const tarball = path.join(packed, packResult.filename);
  runNpm(["install", "--global", "--prefix", prefix, "--ignore-scripts", tarball]);
  const executable =
    process.platform === "win32"
      ? path.join(prefix, "codex-reset.cmd")
      : path.join(prefix, "bin", "codex-reset");
  await access(executable);
  const installedPackage =
    process.platform === "win32"
      ? path.join(prefix, "node_modules", "codex-reset-kit")
      : path.join(prefix, "lib", "node_modules", "codex-reset-kit");
  const installedBin = path.join(installedPackage, "bin", "codex-reset.js");
  await access(installedBin);
  const help =
    process.platform === "win32"
      ? run(process.execPath, [installedBin, "help"], root)
      : run(executable, ["help"], root);
  if (!help.includes("Codex Reset Kit") || !help.includes("There is no --yes option")) {
    throw new Error("The installed npm executable did not expose the hardened help text.");
  }

  const installedSkill = path.join(
    installedPackage,
    "skills",
    "redeem-codex-reset",
    "scripts",
    "codex-reset.mjs",
  );
  await access(installedSkill);
  const skillHelp = run(process.execPath, [installedSkill, "help"], root);
  if (!skillHelp.includes("Codex Reset Kit")) {
    throw new Error("The installed standalone Skill bundle failed its help smoke test.");
  }
  process.stdout.write("Packed npm CLI and standalone Skill smoke tests passed.\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
