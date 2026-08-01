import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skill = path.join(root, "plugins", "codex-reset-kit", "skills", "redeem-codex-reset");
const skillFile = path.join(skill, "SKILL.md");
const agentFile = path.join(skill, "agents", "openai.yaml");
const bundleFile = path.join(skill, "scripts", "codex-reset.mjs");
const licenseFile = path.join(skill, "LICENSE");
const noticesFile = path.join(skill, "THIRD_PARTY_NOTICES");

const [markdown, agentYaml, bundle, license, notices, entries] = await Promise.all([
  readFile(skillFile, "utf8"),
  readFile(agentFile, "utf8"),
  readFile(bundleFile, "utf8"),
  readFile(licenseFile, "utf8"),
  readFile(noticesFile, "utf8"),
  readdir(skill),
]);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(!markdown.includes("TODO"), "SKILL.md still contains a TODO marker.");
const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1];
assert(frontmatter != null, "SKILL.md needs YAML frontmatter.");
const keys = frontmatter
  .split(/\r?\n/)
  .filter((line) => /^[A-Za-z]/.test(line))
  .map((line) => line.split(":", 1)[0]);
assert(
  keys.join(",") === "name,description",
  "SKILL.md frontmatter may contain only name and description.",
);
assert(
  frontmatter.includes("name: redeem-codex-reset"),
  "Skill name does not match its directory.",
);

assert(agentYaml.includes('display_name: "Codex Reset Remote"'), "Missing display name.");
assert(
  agentYaml.includes("$redeem-codex-reset"),
  "The default prompt must explicitly mention $redeem-codex-reset.",
);
assert(
  agentYaml.includes("allow_implicit_invocation: false"),
  "The destructive workflow must not allow implicit Skill invocation.",
);
assert(
  markdown.includes("Never run the CLI `commit`, `redeem`, or `recover` commands from the Skill."),
  "SKILL.md must prohibit bypassing the host-approved MCP tools through the CLI.",
);
assert(
  markdown.includes("redeem_prepared_reset") && markdown.includes("recover_reset_redemption"),
  "SKILL.md must name the only destructive remote tool paths.",
);
assert(
  !markdown.includes("--yes --json") && !markdown.includes("--idempotency-key <"),
  "SKILL.md must not expose an unattended consume or caller-supplied recovery command.",
);
assert(
  markdown.includes("Exit `13`") && markdown.includes("closed an old unprovable journal"),
  "SKILL.md must explain the terminal no-send unknown-closure result.",
);
assert(
  markdown.includes("Exit `14`") && markdown.includes("terminal journal write failed"),
  "SKILL.md must explain the same-attempt recovery required after a terminal journal failure.",
);
assert(bundle.startsWith("#!/usr/bin/env node"), "The bundled executable needs a Node shebang.");
assert(license.includes("MIT License"), "The standalone Skill must include the project license.");
assert(
  notices.includes("cross-spawn") && notices.includes("Zod"),
  "Third-party notices are incomplete.",
);
assert(
  !entries.some((entry) => /^README(?:\.|$)/i.test(entry)),
  "Do not add a README inside the skill.",
);
await access(bundleFile);
await access(licenseFile);

process.stdout.write("Skill structure and generated bundle are valid.\n");
