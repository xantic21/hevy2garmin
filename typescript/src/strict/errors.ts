/** A request or operation that strict in-place mode never performs. */
export class StrictModeViolation extends Error {
  readonly code = "STRICT_MODE_VIOLATION";
  constructor(message: string) {
    super(message);
    this.name = "StrictModeViolation";
  }
}

/** A precondition of a strict write failed; nothing was written to Garmin. */
export class StrictPreconditionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "StrictPreconditionError";
    this.code = code;
  }
}
