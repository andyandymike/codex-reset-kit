import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skill = path.join(root, "skills", "redeem-codex-reset");
const skillFile = path.join(skill, "SKILL.md");
const agentFile = path.join(skill, "agents", "openai.yaml");
const bundleFile = path.join(skill, "scripts", "codex-reset.mjs");

const [markdown, agentYaml, bundle, entries] = await Promise.all([
  readFile(skillFile, "utf8"),
  readFile(agentFile, "utf8"),
  readFile(bundleFile, "utf8"),
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

assert(agentYaml.includes('display_name: "Redeem Codex Reset"'), "Missing display name.");
assert(
  agentYaml.includes("$redeem-codex-reset"),
  "The default prompt must explicitly mention $redeem-codex-reset.",
);
assert(bundle.startsWith("#!/usr/bin/env node"), "The bundled executable needs a Node shebang.");
assert(
  !entries.some((entry) => /^README(?:\.|$)/i.test(entry)),
  "Do not add a README inside the skill.",
);
await access(bundleFile);

process.stdout.write("Skill structure and generated bundle are valid.\n");
