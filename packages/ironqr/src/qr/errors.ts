/**
 * Represents a decoder failure with a stable machine-readable code.
 */
export class ScannerError extends Error {
  /**
   * Creates a scanner error instance.
   *
   * @param code - Error category identifying the failure mode.
   * @param message - Human-readable explanation of the failure.
   */
  constructor(
    public readonly code: 'not_implemented' | 'invalid_input' | 'decode_failed' | 'internal_error',
    message: string,
  ) {
    super(message);
    this.name = 'ScannerError';
  }
}
