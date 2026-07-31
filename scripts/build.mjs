import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
const skillBundle = path.join(root, "skills", "redeem-codex-reset", "scripts", "codex-reset.mjs");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
  cwd: root,
  stdio: "inherit",
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

await build({
  entryPoints: [path.join(root, "src", "cli.ts")],
  outfile: skillBundle,
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

const bundledSource = await readFile(skillBundle, "utf8");
await writeFile(skillBundle, bundledSource.replace(/[ \t]+$/gm, ""), "utf8");

if (process.platform !== "win32") {
  await chmod(skillBundle, 0o755);
}
