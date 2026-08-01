// The package's public library surface is intentionally read-only/pure. Real redemption is owned
// only by the local interactive CLI or the plugin's host-approved MCP adapter.
export { type CommandEnvelope, type CommandExecution, EXIT_CODE } from "./application/output.js";
export {
  type CreditSelector,
  type SelectedCredit,
  selectCredit,
} from "./domain/select-credit.js";
export { type VerificationResult, verifyRedemption } from "./domain/verification.js";
