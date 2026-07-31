const SENSITIVE_KEY = /^(?:accessToken|refreshToken|apiKey|authorization|cookie|password|secret)$/i;

export function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(
      /("(?:accessToken|refreshToken|apiKey|authorization|cookie|password|secret)"\s*:\s*)"[^"]*"/gi,
      '$1"[REDACTED]"',
    );
}

export function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactUnknown);
  }
  if (value == null || typeof value !== "object") {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactUnknown(child);
  }
  return output;
}
