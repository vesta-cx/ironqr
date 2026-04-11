/**
 * Error raised when a public scanner entry point is still a stub.
 */
export class ScannerNotImplementedError extends Error {
  /**
   * Creates a not-implemented error for the requested operation.
   *
   * @param operation - Public API operation that has not been implemented yet.
   */
  constructor(operation: string) {
    super(`Scanner operation not implemented yet: ${operation}`);
    this.name = 'ScannerNotImplementedError';
  }
}

/**
 * Throws a standardized not-implemented error for a public API operation.
 *
 * @param operation - Public API operation that has not been implemented yet.
 * @returns This function never returns.
 * @throws {ScannerNotImplementedError} Always thrown for the requested operation.
 */
export const notImplemented = (operation: string): never => {
  throw new ScannerNotImplementedError(operation);
};
