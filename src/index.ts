// The package's public library surface is intentionally read-only/pure. Real redemption is
// available only through the local interactive CLI, which owns confirmation and attempt journals.
export { type CommandEnvelope, type CommandExecution, EXIT_CODE } from "./application/output.js";
export {
  type CreditSelector,
  type SelectedCredit,
  selectCredit,
} from "./domain/select-credit.js";
export { type VerificationResult, verifyRedemption } from "./domain/verification.js";
