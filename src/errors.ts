/** Error returned by the eToro API (HTTP status >= 400). */
export class EtoroApiError extends Error {
  override name = "EtoroApiError";
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}

/** Raised when the server's own safety policy blocks an action (not an API error). */
export class PolicyError extends Error {
  override name = "PolicyError";
}

/** Raised for invalid tool input that zod cannot express (cross-field rules). */
export class InputError extends Error {
  override name = "InputError";
}
