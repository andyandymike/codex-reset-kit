import { ResetMcpStdioServer } from "./mcp/stdio-server.js";

const server = new ResetMcpStdioServer();

server.start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[codex-reset-kit:mcp] ${message}\n`);
  process.exitCode = 1;
});
