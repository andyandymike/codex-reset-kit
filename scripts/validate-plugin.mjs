import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(root, "plugins", "codex-reset-kit");
const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
const marketplacePath = path.join(root, ".agents", "plugins", "marketplace.json");
const mcpBundlePath = path.join(pluginRoot, "mcp", "codex-reset-mcp.mjs");
const packageMetadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const marketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
const mcpBundle = await readFile(mcpBundlePath, "utf8");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(manifest.name === "codex-reset-kit", "Plugin name must match its directory.");
assert(manifest.version === packageMetadata.version, "Plugin and npm versions must match.");
assert(
  typeof manifest.description === "string" && manifest.description.length > 0,
  "Missing description.",
);
assert(manifest.author?.name === "andyandymike", "Plugin author is missing.");
assert(manifest.skills === "./skills/", "Plugin skills path must stay inside the plugin.");
assert(
  manifest.mcpServers != null && typeof manifest.mcpServers === "object",
  "Plugin must inline its bundled MCP server configuration.",
);
assert(manifest.interface?.displayName === "Codex Reset Kit", "Missing plugin display name.");
assert(
  manifest.interface?.developerName === manifest.author.name,
  "Plugin developer and author names must match.",
);
assert(
  Array.isArray(manifest.interface?.defaultPrompt) &&
    manifest.interface.defaultPrompt.length > 0 &&
    manifest.interface.defaultPrompt.length <= 3 &&
    manifest.interface.defaultPrompt.every(
      (prompt) => typeof prompt === "string" && prompt.length > 0 && prompt.length <= 128,
    ),
  "Plugin default prompts must contain one to three short strings.",
);

const server = manifest.mcpServers?.["codex-reset-kit"];
assert(server?.command === "node", "Bundled MCP server must launch with Node.");
assert(
  Array.isArray(server.args) &&
    server.args.length === 1 &&
    server.args[0] === "./mcp/codex-reset-mcp.mjs" &&
    server.cwd === ".",
  "Bundled MCP server must resolve only the committed plugin-local bundle.",
);
assert(server.default_tools_approval_mode === "auto", "Unexpected default MCP approval mode.");
for (const tool of ["redeem_prepared_reset", "recover_reset_redemption"]) {
  assert(server.tools?.[tool]?.approval_mode === "prompt", `${tool} must always prompt.`);
  assert(mcpBundle.includes(tool), `MCP bundle does not contain ${tool}.`);
}
assert(mcpBundle.startsWith("#!/usr/bin/env node"), "MCP bundle needs a Node shebang.");

assert(marketplace.name === "codex-reset-kit", "Marketplace name is incorrect.");
const marketplaceEntry = marketplace.plugins?.find((entry) => entry.name === "codex-reset-kit");
assert(marketplaceEntry != null, "Marketplace is missing the plugin entry.");
assert(
  marketplaceEntry.source?.source === "local" &&
    marketplaceEntry.source?.path === "./plugins/codex-reset-kit",
  "Marketplace source must point at the nested plugin directory.",
);
assert(
  marketplaceEntry.policy?.installation === "AVAILABLE" &&
    marketplaceEntry.policy?.authentication === "ON_INSTALL",
  "Marketplace policy is incomplete.",
);
assert(marketplaceEntry.category === "Productivity", "Marketplace category is missing.");

await access(path.join(pluginRoot, "skills", "redeem-codex-reset", "SKILL.md"));
await access(mcpBundlePath);

process.stdout.write("Plugin manifest, marketplace entry, MCP policy, and bundle are valid.\n");
