const SENSITIVE_KEY = /^(?:accessToken|refreshToken|apiKey|authorization|cookie|password|secret)$/i;

function isUnsafeControlCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    codePoint === 0xfeff
  );
}

export function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && isUnsafeControlCodePoint(codePoint)) {
      return true;
    }
  }
  return false;
}

function neutralizeControlCharacters(value: string): string {
  let output = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === 0x1b) {
      continue;
    }
    if (
      codePoint !== undefined &&
      isUnsafeControlCodePoint(codePoint) &&
      codePoint !== 0x09 &&
      codePoint !== 0x0a &&
      codePoint !== 0x0d
    ) {
      output += "�";
      continue;
    }
    output += character;
  }
  return output;
}

function flattenTerminalSeparators(value: string): string {
  let output = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    output += codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d ? " " : character;
  }
  return output;
}

export function redactText(value: string): string {
  return neutralizeControlCharacters(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(
      /("(?:accessToken|refreshToken|apiKey|authorization|cookie|password|secret)"\s*:\s*)"[^"]*"/gi,
      '$1"[REDACTED]"',
    );
}

export function safeTerminalField(value: string, maxLength = 512): string {
  const cleaned = flattenTerminalSeparators(redactText(value)).replace(/\s+/gu, " ").trim();
  return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength - 1)}…`;
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
