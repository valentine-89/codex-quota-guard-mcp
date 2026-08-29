import { redactSensitiveText } from "./security.js";

export class GuardError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(redactSensitiveText(message));
    this.name = "GuardError";
  }
}

export function toGuardError(error: unknown): GuardError {
  if (error instanceof GuardError) return error;
  if (error instanceof Error) return new GuardError("INTERNAL_ERROR", error.message);
  return new GuardError("INTERNAL_ERROR", String(error));
}
