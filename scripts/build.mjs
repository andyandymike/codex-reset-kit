import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
const pluginRoot = path.join(root, "plugins", "codex-reset-kit");
const skillBundle = path.join(
  pluginRoot,
  "skills",
  "redeem-codex-reset",
  "scripts",
  "codex-reset.mjs",
);
const mcpBundle = path.join(pluginRoot, "mcp", "codex-reset-mcp.mjs");
const rootLicense = path.join(root, "LICENSE");
const skillLicense = path.join(pluginRoot, "skills", "redeem-codex-reset", "LICENSE");
const rootNotices = path.join(root, "THIRD_PARTY_NOTICES");
const skillNotices = path.join(pluginRoot, "skills", "redeem-codex-reset", "THIRD_PARTY_NOTICES");
const packageMetadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const cliMainSource = await readFile(path.join(root, "src", "cli-main.ts"), "utf8");
const mcpServerSource = await readFile(path.join(root, "src", "mcp", "stdio-server.ts"), "utf8");

if (
  !cliMainSource.includes(`const VERSION = "${packageMetadata.version}";`) ||
  !mcpServerSource.includes(`SERVER_VERSION = "${packageMetadata.version}"`)
) {
  throw new Error("Embedded CLI and MCP versions must match package.json.");
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await mkdir(path.dirname(mcpBundle), { recursive: true });

const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
  cwd: root,
  stdio: "inherit",
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

for (const [entryPoint, outfile] of [
  [path.join(root, "src", "cli.ts"), skillBundle],
  [path.join(root, "src", "mcp-server.ts"), mcpBundle],
]) {
  await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    sourcemap: false,
    legalComments: "eof",
    banner: {
      js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);',
    },
  });
  const bundledSource = await readFile(outfile, "utf8");
  await writeFile(outfile, bundledSource.replace(/[ \t]+$/gm, ""), "utf8");
}
await copyFile(rootLicense, skillLicense);
await copyFile(rootNotices, skillNotices);

if (process.platform !== "win32") {
  await chmod(skillBundle, 0o755);
  await chmod(mcpBundle, 0o755);
}
