const REDACTIONS: Array<[RegExp, string]> = [
  [/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED_OPENAI_KEY]"],
  [/(Authorization\s*:\s*Bearer\s+)[^\s"']+/gi, "$1[REDACTED]"],
  [/(access[_-]?token|refresh[_-]?token|api[_-]?key)(["'\s:=]+)[^\s,"'}]+/gi, "$1$2[REDACTED]"],
  [/\b(eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, "[REDACTED_JWT]"],
];

export function redactSensitiveText(value: string, maxLength = 8_000): string {
  let redacted = value;
  for (const [pattern, replacement] of REDACTIONS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}…[TRUNCATED]` : redacted;
}

export function sanitizeStringList(values: string[]): string[] {
  return values.slice(0, 200).map((value) => redactSensitiveText(value, 2_000));
}
