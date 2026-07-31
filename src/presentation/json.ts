import type { CommandEnvelope } from "../application/output.js";
import { redactUnknown } from "../security/redact.js";

export function renderJson(envelope: CommandEnvelope): string {
  return JSON.stringify(redactUnknown(envelope), null, 2);
}
