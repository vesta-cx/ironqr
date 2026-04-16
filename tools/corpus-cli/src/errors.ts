/** Tagged error for filesystem I/O failures. */
export class FilesystemError {
  readonly _tag = 'FilesystemError';
  constructor(
    readonly message: string,
    readonly cause?: unknown,
  ) {}
}

/** Tagged error for network fetch failures. */
export class FetchError {
  readonly _tag = 'FetchError';
  constructor(
    readonly message: string,
    readonly cause?: unknown,
  ) {}
}

/** Tagged error for schema/JSON parse failures. */
export class ParseError {
  readonly _tag = 'ParseError';
  constructor(
    readonly message: string,
    readonly cause?: unknown,
  ) {}
}

/** Tagged error for unsupported media type or file extension. */
export class UnsupportedMediaError {
  readonly _tag = 'UnsupportedMediaError';
  constructor(readonly message: string) {}
}

/** Tagged error for image processing failures (sharp). */
export class ImageProcessingError {
  readonly _tag = 'ImageProcessingError';
  constructor(
    readonly message: string,
    readonly cause?: unknown,
  ) {}
}

/** Tagged error for corpus data integrity violations (e.g. conflicting dedup). */
export class CorpusIntegrityError {
  readonly _tag = 'CorpusIntegrityError';
  constructor(readonly message: string) {}
}

/** Tagged error for policy/validation violations (e.g. disallowed host). */
export class PolicyError {
  readonly _tag = 'PolicyError';
  constructor(readonly message: string) {}
}

/** Union of all corpus-cli domain errors. */
export type CorpusError =
  | FilesystemError
  | FetchError
  | ParseError
  | UnsupportedMediaError
  | ImageProcessingError
  | CorpusIntegrityError
  | PolicyError;
