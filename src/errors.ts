export class BridgeError extends Error {
  constructor(public code: string, message: string, public details: Record<string, unknown> = {}) {
    super(message);
  }
}

export function errorResult(error: unknown) {
  return error instanceof BridgeError
    ? { code: error.code, message: error.message, ...error.details }
    : { code: "internal_error", message: "The bridge failed unexpectedly. No credentials or remote response bodies are included in this error." };
}
