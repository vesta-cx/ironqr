export class ScannerNotImplementedError extends Error {
  constructor(operation: string) {
    super(`Scanner operation not implemented yet: ${operation}`);
    this.name = 'ScannerNotImplementedError';
  }
}

export const notImplemented = (operation: string): never => {
  throw new ScannerNotImplementedError(operation);
};
