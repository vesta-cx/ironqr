import { Effect } from 'effect';
import type { DecodedSegment, DecodeGridResult } from '../contracts/index.js';
import { ScannerError } from './errors.js';
import {
  ALPHANUMERIC_CHARSET,
  buildDataModulePositions,
  buildFunctionModuleMask,
  type DecodedFormatInfoCandidate,
  type DecodedVersionInfoCandidate,
  decodeFormatInfoCandidates,
  decodeVersionInfoCandidates,
  getRemainderBits,
  getVersionBlockInfo,
  getVersionFromSize,
  type QrErrorCorrectionLevel,
  type QrVersionBlockInfo,
  unmask,
} from './qr-spec.js';
import { correctRsBlock, ReedSolomonError } from './reed-solomon.js';

const LATIN1_DECODER = new TextDecoder('iso-8859-1', { fatal: false });
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });
const SHIFT_JIS_DECODER = new TextDecoder('shift_jis', { fatal: false });
const ASCII_DECODER = new TextDecoder('us-ascii', { fatal: false });
const UTF16BE_DECODER = new TextDecoder('utf-16be', { fatal: false });
const BIG5_DECODER = new TextDecoder('big5', { fatal: false });
const GB18030_DECODER = new TextDecoder('gb18030', { fatal: false });
const EUC_KR_DECODER = new TextDecoder('euc-kr', { fatal: false });

const FORMAT_INFO_BITS = 15;

interface CachedDecodeLayout {
  readonly version: number;
  readonly reserved: boolean[][];
  readonly dataPositions: readonly (readonly [number, number])[];
  readonly remainderBits: number;
}

interface DecodedGridPrelude {
  readonly size: number;
  readonly version: number;
  readonly matrix: boolean[][];
  readonly errorCorrectionLevel: QrErrorCorrectionLevel;
  readonly maskPattern: number;
  readonly hammingDistance: number;
}

const MAX_FORMAT_INFO_RESCUE_DISTANCE = 5;
const MAX_FORMAT_INFO_RESCUE_CANDIDATES = 4;
const MAX_VERSION_INFO_RESCUE_DISTANCE = 8;
const MAX_VERSION_INFO_RESCUE_CANDIDATES = 4;

const decodeLayoutCache = new Map<string, CachedDecodeLayout>();
const blockInfoCache = new Map<string, QrVersionBlockInfo>();

/**
 * Decodes a logical QR module grid all the way to a public scan result.
 *
 * @param input - Square boolean grid representing dark and light modules.
 * @returns A decoded QR payload with structural metadata.
 * @throws {ScannerError} Thrown when the grid is malformed or cannot be decoded.
 */
export const decodeGridLogical = (input: {
  readonly grid: readonly (readonly boolean[])[];
}): Effect.Effect<DecodeGridResult, ScannerError> => {
  return Effect.gen(function* () {
    const candidates = yield* Effect.try({
      try: () => prepareDecodeGridPreludes(input.grid),
      catch: (error) =>
        error instanceof ScannerError
          ? error
          : new ScannerError(
              'internal_error',
              error instanceof Error ? error.message : `Unexpected decode error: ${String(error)}`,
            ),
    });

    let lastDecodeError: ScannerError | null = null;
    for (const prepared of candidates) {
      const decoded = yield* decodePreparedGrid(prepared).pipe(
        Effect.catchIf(
          (error: unknown): error is ScannerError =>
            error instanceof ScannerError && error.code === 'decode_failed',
          (error) => {
            lastDecodeError = error;
            return Effect.succeed(null);
          },
        ),
      );
      if (decoded !== null) return decoded;
    }

    if (lastDecodeError) return yield* Effect.fail(lastDecodeError);
    return yield* Effect.fail(
      new ScannerError('decode_failed', 'All QR decode prelude candidates failed.'),
    );
  });
};

const prepareDecodeGridPreludes = (
  grid: readonly (readonly boolean[])[],
): readonly DecodedGridPrelude[] => {
  if (grid.length === 0) {
    throw new ScannerError('invalid_input', 'QR grid must not be empty.');
  }

  const size = grid.length;
  for (const row of grid) {
    if (row.length !== size) {
      throw new ScannerError('invalid_input', 'QR grid must be square.');
    }
  }

  const version = getVersionFromSize(size);
  const matrix = grid.map((row) => [...row]);
  const formatCandidates = buildFormatPreludeCandidates(matrix);
  const versionCandidates = buildVersionPreludeCandidates(matrix, version);
  const preludes: DecodedGridPrelude[] = [];
  const seen = new Set<string>();

  for (const formatCandidate of formatCandidates) {
    for (const versionCandidate of versionCandidates) {
      const key = `${versionCandidate.version}:${formatCandidate.errorCorrectionLevel}:${formatCandidate.maskPattern}`;
      if (seen.has(key)) continue;
      seen.add(key);
      preludes.push({
        size,
        version: versionCandidate.version,
        matrix,
        errorCorrectionLevel: formatCandidate.errorCorrectionLevel,
        maskPattern: formatCandidate.maskPattern,
        hammingDistance: formatCandidate.hammingDistance,
      });
    }
  }

  if (preludes.length === 0) {
    throw new ScannerError('decode_failed', 'Could not build any QR decode preludes.');
  }

  return preludes;
};

const buildFormatPreludeCandidates = (
  matrix: boolean[][],
): readonly DecodedFormatInfoCandidate[] => {
  const strict = decodeFormatInfoCandidates(matrix, { maxDistance: 3, limit: 1 });
  const rescue = decodeFormatInfoCandidates(matrix, {
    maxDistance: MAX_FORMAT_INFO_RESCUE_DISTANCE,
    limit: MAX_FORMAT_INFO_RESCUE_CANDIDATES,
  });
  const candidates = dedupeFormatPreludeCandidates([...strict, ...rescue]);
  if (candidates.length > 0) return candidates;

  throw new ScannerError('decode_failed', 'Could not decode QR format information.');
};

const dedupeFormatPreludeCandidates = (
  candidates: readonly DecodedFormatInfoCandidate[],
): readonly DecodedFormatInfoCandidate[] => {
  const bestByKey = new Map<string, DecodedFormatInfoCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.errorCorrectionLevel}:${candidate.maskPattern}`;
    const current = bestByKey.get(key);
    if (!current || candidate.hammingDistance < current.hammingDistance) {
      bestByKey.set(key, candidate);
    }
  }
  return [...bestByKey.values()].sort(
    (left, right) => left.hammingDistance - right.hammingDistance,
  );
};

const buildVersionPreludeCandidates = (
  matrix: boolean[][],
  sizeImpliedVersion: number,
): readonly DecodedVersionInfoCandidate[] => {
  if (sizeImpliedVersion < 7) {
    return [{ version: sizeImpliedVersion, hammingDistance: 0 }];
  }

  const strict = decodeVersionInfoCandidates(matrix, { maxDistance: 3, limit: 1 });
  if (strict[0]?.version === sizeImpliedVersion) return strict;

  const rescue = decodeVersionInfoCandidates(matrix, {
    maxDistance: MAX_VERSION_INFO_RESCUE_DISTANCE,
    limit: MAX_VERSION_INFO_RESCUE_CANDIDATES,
  });
  const sizeMatched = rescue.find((candidate) => candidate.version === sizeImpliedVersion);
  return [sizeMatched ?? { version: sizeImpliedVersion, hammingDistance: 0 }];
};

const decodePreparedGrid = (
  prepared: DecodedGridPrelude,
): Effect.Effect<DecodeGridResult, ScannerError> => {
  return Effect.try({
    try: () => {
      const layout = getCachedDecodeLayout(prepared.size, prepared.version);
      const matrix = prepared.matrix.map((row) => [...row]);
      const unmasked = unmask(matrix, prepared.maskPattern, layout.reserved);
      const dataBits = extractDataBits(unmasked, layout.dataPositions);
      const blockInfo = getCachedBlockInfo(prepared.version, prepared.errorCorrectionLevel);
      const expectedBits = blockInfo.totalCodewords * 8 + layout.remainderBits;

      if (dataBits.length !== expectedBits) {
        throw new ScannerError(
          'decode_failed',
          `Unexpected data module count for version ${prepared.version}-${prepared.errorCorrectionLevel}: got ${dataBits.length}, expected ${expectedBits}.`,
        );
      }

      const codewordBits = dataBits.slice(0, blockInfo.totalCodewords * 8);
      const codewords = Array.from(bytesFromBits(codewordBits));
      const blocks = splitInterleavedCodewords(codewords, blockInfo);
      const dataCodewords = correctAndReinterleaveDataCodewords(blocks);
      const payload = decodePayloadFromDataCodewords(dataCodewords, prepared.version);

      return {
        payload: {
          kind: payload.kind,
          text: payload.text,
          bytes: payload.bytes,
        },
        confidence: formatInfoConfidence(prepared.hammingDistance),
        version: prepared.version,
        errorCorrectionLevel: prepared.errorCorrectionLevel,
        bounds: {
          x: 0,
          y: 0,
          width: prepared.size,
          height: prepared.size,
        },
        corners: {
          topLeft: { x: 0, y: 0 },
          topRight: { x: prepared.size, y: 0 },
          bottomRight: { x: prepared.size, y: prepared.size },
          bottomLeft: { x: 0, y: prepared.size },
        },
        headers: payload.headers.length > 0 ? payload.headers : [['mode', 'unknown']],
        segments: payload.segments,
      };
    },
    catch: (error) =>
      error instanceof ScannerError
        ? error
        : new ScannerError(
            'internal_error',
            error instanceof Error ? error.message : `Unexpected decode error: ${String(error)}`,
          ),
  });
};

const getCachedDecodeLayout = (size: number, version: number): CachedDecodeLayout => {
  const key = `${size}:${version}`;
  const cached = decodeLayoutCache.get(key);
  if (cached) return cached;

  const reserved = buildFunctionModuleMask(size, version);
  const layout = {
    version,
    reserved,
    dataPositions: buildDataModulePositions(size, reserved),
    remainderBits: getRemainderBits(version),
  } satisfies CachedDecodeLayout;
  decodeLayoutCache.set(key, layout);
  return layout;
};

const getCachedBlockInfo = (
  version: number,
  errorCorrectionLevel: QrErrorCorrectionLevel,
): QrVersionBlockInfo => {
  const key = `${version}:${errorCorrectionLevel}`;
  const cached = blockInfoCache.get(key);
  if (cached) return cached;

  const blockInfo = getVersionBlockInfo(version, errorCorrectionLevel);
  blockInfoCache.set(key, blockInfo);
  return blockInfo;
};

/**
 * Bit-level reader for QR segment payloads.
 */
class BitReader {
  private readonly bits: number[];
  private index = 0;

  /**
   * Expands a byte array into a bitstream for sequential reading.
   *
   * @param bytes - Bytes to expose as a stream of bits.
   */
  constructor(bytes: readonly number[]) {
    const bits: number[] = [];
    for (const byte of bytes) {
      for (let bit = 7; bit >= 0; bit -= 1) {
        bits.push((byte >> bit) & 1);
      }
    }
    this.bits = bits;
  }

  /**
   * Reads the next N bits from the stream.
   *
   * @param length - Number of bits to consume.
   * @returns The consumed bits packed into an integer.
   * @throws {ScannerError} Thrown when the request is invalid or the stream ends early.
   */
  read(length: number): number {
    if (length < 0) {
      throw new ScannerError('internal_error', `Cannot read a negative number of bits: ${length}`);
    }

    if (this.index + length > this.bits.length) {
      throw new ScannerError('decode_failed', 'Unexpected end of QR data stream.');
    }

    let value = 0;
    for (let offset = 0; offset < length; offset += 1) {
      value = (value << 1) | (this.bits[this.index + offset] ?? 0);
    }

    this.index += length;
    return value;
  }

  /**
   * Reports how many unread bits remain.
   *
   * @returns Remaining bit count.
   */
  remaining(): number {
    return this.bits.length - this.index;
  }
}

/**
 * Maps plain text to the most specific payload kind currently recognized.
 *
 * @param text - Decoded text payload.
 * @returns The inferred payload kind.
 */
const formatInfoConfidence = (hammingDistance: number): number => {
  return 1 - hammingDistance / FORMAT_INFO_BITS;
};

const classifyPayload = (
  text: string,
): 'text' | 'url' | 'email' | 'sms' | 'wifi' | 'contact' | 'calendar' | 'binary' | 'unknown' => {
  if (/^https?:\/\//i.test(text)) {
    return 'url';
  }

  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
    return 'email';
  }

  return 'text';
};

/**
 * Decodes a byte segment with the requested character encoding.
 *
 * @param bytes - Raw bytes from the QR segment.
 * @param encoding - ECI-resolved encoding label.
 * @returns The decoded string.
 * @throws {ScannerError} Thrown when the encoding label is unsupported.
 */
const decodeText = (bytes: Uint8Array, encoding: string): string => {
  switch (encoding) {
    case 'iso-8859-1':
      return LATIN1_DECODER.decode(bytes);
    case 'utf-8':
      return UTF8_DECODER.decode(bytes);
    case 'shift_jis':
      return SHIFT_JIS_DECODER.decode(bytes);
    case 'us-ascii':
      return ASCII_DECODER.decode(bytes);
    case 'utf-16be':
      return UTF16BE_DECODER.decode(bytes);
    case 'big5':
      return BIG5_DECODER.decode(bytes);
    case 'gb18030':
      return GB18030_DECODER.decode(bytes);
    case 'euc-kr':
      return EUC_KR_DECODER.decode(bytes);
    default:
      throw new ScannerError('decode_failed', `Unsupported QR ECI charset: ${encoding}`);
  }
};

/**
 * Decodes an alphanumeric-mode QR segment.
 *
 * @param reader - Bit reader positioned at the segment payload.
 * @param count - Number of encoded characters.
 * @returns The decoded text segment.
 */
const decodeAlphanumeric = (reader: BitReader, count: number): string => {
  let text = '';

  for (let remaining = count; remaining >= 2; remaining -= 2) {
    const value = reader.read(11);
    const first = Math.floor(value / 45);
    const second = value % 45;
    const firstChar = ALPHANUMERIC_CHARSET[first];
    const secondChar = ALPHANUMERIC_CHARSET[second];

    if (firstChar === undefined || secondChar === undefined) {
      throw new ScannerError('decode_failed', 'Invalid alphanumeric value in QR stream.');
    }

    text += `${firstChar}${secondChar}`;
  }

  if (count % 2 === 1) {
    const value = reader.read(6);
    const char = ALPHANUMERIC_CHARSET[value];
    if (char === undefined) {
      throw new ScannerError('decode_failed', 'Invalid alphanumeric value in QR stream.');
    }
    text += char;
  }

  return text;
};

/**
 * Decodes a numeric-mode QR segment.
 *
 * @param reader - Bit reader positioned at the segment payload.
 * @param count - Number of encoded digits.
 * @returns The decoded digit string.
 */
const decodeNumeric = (reader: BitReader, count: number): string => {
  let text = '';
  let remaining = count;

  while (remaining >= 3) {
    const value = reader.read(10);
    if (value > 999) throw new ScannerError('decode_failed', 'Invalid numeric segment group.');
    text += value.toString().padStart(3, '0');
    remaining -= 3;
  }

  if (remaining === 2) {
    const value = reader.read(7);
    if (value > 99) throw new ScannerError('decode_failed', 'Invalid numeric segment group.');
    text += value.toString().padStart(2, '0');
  } else if (remaining === 1) {
    const value = reader.read(4);
    if (value > 9) throw new ScannerError('decode_failed', 'Invalid numeric segment digit.');
    text += value.toString();
  }

  return text;
};

/**
 * Reads a byte-mode QR segment.
 *
 * @param reader - Bit reader positioned at the segment payload.
 * @param count - Number of bytes to read.
 * @returns The raw segment bytes.
 */
const decodeByteSegment = (reader: BitReader, count: number): Uint8Array => {
  const bytes = new Uint8Array(count);
  for (let index = 0; index < count; index += 1) {
    bytes[index] = reader.read(8);
  }

  return bytes;
};

/**
 * Decodes a kanji-mode QR segment into Shift-JIS bytes.
 *
 * @param reader - Bit reader positioned at the segment payload.
 * @param count - Number of encoded kanji characters.
 * @returns Shift-JIS bytes for the segment.
 */
const decodeKanjiSegment = (reader: BitReader, count: number): Uint8Array => {
  const bytes = new Uint8Array(count * 2);

  for (let index = 0; index < count; index += 1) {
    const value = reader.read(13);
    let sjis = (Math.floor(value / 0xc0) << 8) | (value % 0xc0);
    sjis += sjis < 0x1f00 ? 0x8140 : 0xc140;
    bytes[index * 2] = (sjis >> 8) & 0xff;
    bytes[index * 2 + 1] = sjis & 0xff;
  }

  return bytes;
};

/**
 * Reads a variable-width ECI assignment number.
 *
 * @param reader - Bit reader positioned after the ECI mode indicator.
 * @returns The numeric ECI assignment.
 */
const readEciAssignmentNumber = (reader: BitReader): number => {
  const firstByte = reader.read(8);

  if ((firstByte & 0x80) === 0) {
    return firstByte & 0x7f;
  }

  if ((firstByte & 0xc0) === 0x80) {
    return ((firstByte & 0x3f) << 8) | reader.read(8);
  }

  if ((firstByte & 0xe0) === 0xc0) {
    return ((firstByte & 0x1f) << 16) | reader.read(16);
  }

  throw new ScannerError('decode_failed', 'Invalid ECI assignment number.');
};

/**
 * Maps a supported QR ECI assignment number to a TextDecoder label.
 *
 * @param assignmentNumber - Numeric ECI assignment.
 * @returns The corresponding encoding label.
 */
const getEciEncodingLabel = (assignmentNumber: number): string => {
  switch (assignmentNumber) {
    case 1:
    case 3:
      return 'iso-8859-1';
    case 20:
      return 'shift_jis';
    case 25:
      return 'utf-16be';
    case 26:
      return 'utf-8';
    case 27:
      return 'us-ascii';
    case 28:
      return 'big5';
    case 29:
      return 'gb18030';
    case 30:
      return 'euc-kr';
    default:
      throw new ScannerError('decode_failed', `Unsupported ECI assignment: ${assignmentNumber}`);
  }
};

/**
 * Decodes the QR segment stream carried by corrected data codewords.
 *
 * @param dataCodewords - Corrected data codewords in logical order.
 * @param version - QR version used to determine segment count widths.
 * @returns Decoded text, bytes, inferred payload kind, and segment headers.
 */
const decodePayloadFromDataCodewords = (
  dataCodewords: readonly number[],
  version: number,
): {
  readonly text: string;
  readonly bytes: Uint8Array;
  readonly kind:
    | 'text'
    | 'url'
    | 'email'
    | 'sms'
    | 'wifi'
    | 'contact'
    | 'calendar'
    | 'binary'
    | 'unknown';
  readonly headers: Array<readonly [string, string]>;
  readonly segments: readonly DecodedSegment[];
} => {
  const reader = new BitReader(dataCodewords);
  const headers: Array<readonly [string, string]> = [];
  const segments: DecodedSegment[] = [];
  const bytes: number[] = [];
  let text = '';
  let payloadKind:
    | 'text'
    | 'url'
    | 'email'
    | 'sms'
    | 'wifi'
    | 'contact'
    | 'calendar'
    | 'binary'
    | 'unknown' = 'unknown';
  let currentEncoding = 'iso-8859-1';

  const numericCountBits = version <= 9 ? 10 : version <= 26 ? 12 : 14;
  const alphanumericCountBits = version <= 9 ? 9 : version <= 26 ? 11 : 13;
  const byteCountBits = version <= 9 ? 8 : 16;
  const kanjiCountBits = version <= 9 ? 8 : version <= 26 ? 10 : 12;

  // Walk the mode stream one segment at a time, updating the active ECI state as needed.
  while (reader.remaining() >= 4) {
    const mode = reader.read(4);
    if (mode === 0) {
      break;
    }

    if (mode === 0b0010) {
      const count = reader.read(alphanumericCountBits);
      const segmentText = decodeAlphanumeric(reader, count);
      const segmentBytes = new TextEncoder().encode(segmentText);
      text += segmentText;
      bytes.push(...segmentBytes);
      payloadKind = classifyPayload(text);
      headers.push(['mode', 'alphanumeric']);
      segments.push({ mode: 'alphanumeric', text: segmentText, bytes: segmentBytes });
      continue;
    }

    if (mode === 0b0100) {
      const count = reader.read(byteCountBits);
      const segmentBytes = decodeByteSegment(reader, count);
      bytes.push(...segmentBytes);
      const segmentText = decodeText(segmentBytes, currentEncoding);
      text += segmentText;
      payloadKind = classifyPayload(text);
      headers.push(['mode', 'byte']);
      segments.push({ mode: 'byte', text: segmentText, bytes: segmentBytes });
      continue;
    }

    if (mode === 0b0001) {
      const count = reader.read(numericCountBits);
      const segmentText = decodeNumeric(reader, count);
      const segmentBytes = new TextEncoder().encode(segmentText);
      text += segmentText;
      bytes.push(...segmentBytes);
      payloadKind = classifyPayload(text);
      headers.push(['mode', 'numeric']);
      segments.push({ mode: 'numeric', text: segmentText, bytes: segmentBytes });
      continue;
    }

    if (mode === 0b1000) {
      const count = reader.read(kanjiCountBits);
      const segmentBytes = decodeKanjiSegment(reader, count);
      bytes.push(...segmentBytes);
      const segmentText = decodeText(segmentBytes, 'shift_jis');
      text += segmentText;
      payloadKind = classifyPayload(text);
      headers.push(['mode', 'kanji']);
      segments.push({ mode: 'kanji', text: segmentText, bytes: segmentBytes });
      continue;
    }

    if (mode === 0b0111) {
      const assignmentNumber = readEciAssignmentNumber(reader);
      currentEncoding = getEciEncodingLabel(assignmentNumber);
      headers.push(['mode', 'eci']);
      headers.push(['encoding', currentEncoding]);
      segments.push({ mode: 'eci', text: currentEncoding, bytes: new Uint8Array(0) });
      continue;
    }

    if (mode === 0b0101) {
      headers.push(['mode', 'fnc1-first']);
      segments.push({ mode: 'fnc1-first', text: '', bytes: new Uint8Array(0) });
      continue;
    }

    if (mode === 0b1001) {
      const applicationIndicator = reader.read(8);
      headers.push(['mode', 'fnc1-second']);
      headers.push(['application-indicator', applicationIndicator.toString()]);
      segments.push({
        mode: 'fnc1-second',
        text: applicationIndicator.toString(),
        bytes: new Uint8Array(0),
      });
      continue;
    }

    throw new ScannerError(
      'decode_failed',
      `Unsupported QR mode: 0b${mode.toString(2).padStart(4, '0')}`,
    );
  }

  if (bytes.length === 0) {
    bytes.push(...new TextEncoder().encode(text));
  }

  return {
    text,
    bytes: new Uint8Array(bytes),
    kind: payloadKind === 'unknown' ? 'text' : payloadKind,
    headers,
    segments,
  };
};

/**
 * Packs a bit array into byte-aligned codewords.
 *
 * @param bits - Bits to pack, most-significant bit first.
 * @returns Packed bytes.
 */
const bytesFromBits = (bits: readonly number[]): Uint8Array => {
  if (bits.length % 8 !== 0) {
    throw new ScannerError('decode_failed', 'Bit stream length is not byte-aligned.');
  }

  const bytes = new Uint8Array(bits.length / 8);
  for (let index = 0; index < bytes.length; index += 1) {
    let value = 0;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value << 1) | (bits[index * 8 + bit] ?? 0);
    }
    bytes[index] = value;
  }
  return bytes;
};

/**
 * Reads data-module bits from an unmasked QR matrix.
 *
 * @param matrix - Unmasked QR matrix.
 * @param dataPositions - Precomputed data-module coordinates.
 * @returns Data bits in QR scan order.
 */
const extractDataBits = (
  matrix: boolean[][],
  dataPositions: readonly (readonly [number, number])[],
): number[] => {
  const bits: number[] = [];

  for (const [row, col] of dataPositions) {
    bits.push(matrix[row]?.[col] ? 1 : 0);
  }

  return bits;
};

interface RawBlock {
  readonly dataCodewords: number[];
  readonly ecCodewords: number[];
}

/**
 * Splits interleaved QR codewords into their original RS blocks.
 *
 * @param codewords - Interleaved codeword stream read from the matrix.
 * @param blockInfo - Block layout for the current version and EC level.
 * @returns Raw blocks containing separated data and ECC codewords.
 */
const splitInterleavedCodewords = (
  codewords: readonly number[],
  blockInfo: ReturnType<typeof getVersionBlockInfo>,
): RawBlock[] => {
  const blocks: RawBlock[] = [];

  for (const group of blockInfo.groups) {
    for (let repeat = 0; repeat < group.count; repeat += 1) {
      blocks.push({
        dataCodewords: new Array(group.dataCodewords).fill(0),
        ecCodewords: new Array(blockInfo.ecCodewordsPerBlock).fill(0),
      });
    }
  }

  let offset = 0;
  const maxDataCodewords = Math.max(...blocks.map((block) => block.dataCodewords.length), 0);

  // QR interleaves all first data bytes, then all second data bytes, and so on before ECC bytes.
  for (let index = 0; index < maxDataCodewords; index += 1) {
    for (const block of blocks) {
      if (index < block.dataCodewords.length) {
        block.dataCodewords[index] = codewords[offset] ?? 0;
        offset += 1;
      }
    }
  }

  for (let index = 0; index < blockInfo.ecCodewordsPerBlock; index += 1) {
    for (const block of blocks) {
      block.ecCodewords[index] = codewords[offset] ?? 0;
      offset += 1;
    }
  }

  if (offset !== codewords.length) {
    throw new ScannerError(
      'decode_failed',
      `Unexpected interleaved codeword count: consumed ${offset}, expected ${codewords.length}.`,
    );
  }

  return blocks;
};

/**
 * Corrects each RS block independently and reassembles the logical data stream.
 *
 * @param blocks - Raw blocks containing data and ECC codewords.
 * @returns Corrected data codewords in logical order.
 */
const correctAndReinterleaveDataCodewords = (blocks: RawBlock[]): number[] => {
  const correctedBlocks = blocks.map((block) => {
    try {
      const corrected = correctRsBlock(
        [...block.dataCodewords, ...block.ecCodewords],
        block.ecCodewords.length,
      );

      return Array.from(corrected.slice(0, block.dataCodewords.length));
    } catch (error) {
      if (error instanceof ReedSolomonError) {
        throw new ScannerError('decode_failed', error.message);
      }

      throw error;
    }
  });

  const result: number[] = [];

  // Assemble corrected blocks in sequential (logical) order: all of block 0, then block 1, etc.
  // Do NOT re-interleave — the segment parser expects the raw logical codeword sequence.
  for (const block of correctedBlocks) {
    result.push(...block);
  }

  return result;
};
