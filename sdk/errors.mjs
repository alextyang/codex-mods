// Shared error type for every framework and SDK API (sdk/index.d.ts §8.2).
export const ERROR_CODES = Object.freeze([
  'Denied', 'Unavailable', 'OutcomeUnknown', 'Busy', 'Timeout', 'Invalid', 'Conflict', 'Incompatible', 'Disposed',
]);

export class CodexModsError extends Error {
  constructor(code, message, details) {
    if (!ERROR_CODES.includes(code)) throw new TypeError(`Unknown error code: ${code}`);
    super(message);
    this.name = 'CodexModsError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
  toJSON() { return { code: this.code, message: this.message, ...(this.details === undefined ? {} : { details: this.details }) }; }
  static fromJSON(value) { return new CodexModsError(value.code, value.message, value.details); }
}
