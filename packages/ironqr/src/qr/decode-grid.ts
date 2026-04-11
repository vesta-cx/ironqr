import { Effect } from 'effect';
import type { DecodedSegment, DecodeGridResult } from '../contracts/index.js';
import { ScannerError } from './errors.js';
import {
  ALPHANUMERIC_CHARSET,
  buildDataModulePositions,
  buildFunctionModuleMask,
  decodeFormatInfo,
  decodeVersionInfo,
  getRemainderBits,
  getVersionBlockInfo,
  getVersionFromSize,
  unmask,
} from './qr-spec.js';
import { correctRsBlock, ReedSolomonError } from './reed-solomon.js';

const LATIN1_DECODER = new TextDecoder('iso-8859-1', { fatal: false });
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });
const SHIFT_JIS_DECODER = new TextDecoder('shift_jis', { fatal: false });
const ASCII_DECODER = new TextDecoder('us-ascii', { fatal: false });
const UTF16BE_DECODER = new TextDecoder('utf-16be', { fatal: false });
const BIG5_DECODER = new TextDecoder('big5', { fatal: false });
const GBK_DECODER = new TextDecoder('gbk', { fatal: false });
const EUC_KR_DECODER = new TextDecoder('euc-kr', { fatal: false });

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
  return Effect.try({
    try: () => {
      const { grid } = input;
      if (grid.length === 0) {
        throw new ScannerError('invalid_input', 'QR grid must not be empty.');
      }

      const size = grid.length;
      for (const row of grid) {
        if (row.length !== size) {
          throw new ScannerError('invalid_input', 'QR grid must be square.');
        }
      }

      const versionFromSize = getVersionFromSize(size);
      const matrix = grid.map((row) => row.slice());
      const { errorCorrectionLevel, maskPattern } = decodeFormatInfo(matrix);
      const decodedVersion = decodeVersionInfo(matrix);

      if (decodedVersion !== versionFromSize) {
        throw new ScannerError(
          'decode_failed',
          `QR version info mismatch: grid size implies v${versionFromSize}, version bits decode to v${decodedVersion}.`,
        );
      }

      // Strip the data mask, rebuild RS blocks, correct them, and only then parse the segment stream.
      const reserved = buildFunctionModuleMask(size, versionFromSize);
      const unmasked = unmask(matrix, maskPattern, reserved);
      const dataBits = extractDataBits(unmasked, reserved);
      const blockInfo = getVersionBlockInfo(versionFromSize, errorCorrectionLevel);
      const expectedBits = blockInfo.totalCodewords * 8 + getRemainderBits(versionFromSize);

      if (dataBits.length !== expectedBits) {
        throw new ScannerError(
          'decode_failed',
          `Unexpected data module count for version ${versionFromSize}-${errorCorrectionLevel}: got ${dataBits.length}, expected ${expectedBits}.`,
        );
      }

      const codewordBits = dataBits.slice(0, blockInfo.totalCodewords * 8);
      const codewords = Array.from(bytesFromBits(codewordBits));
      const blocks = splitInterleavedCodewords(codewords, blockInfo);
      const dataCodewords = correctAndReinterleaveDataCodewords(blocks);
      const payload = decodePayloadFromDataCodewords(dataCodewords, versionFromSize);

      return {
        payload: {
          kind: payload.kind,
          text: payload.text,
          bytes: payload.bytes,
        },
        confidence: 1,
        version: versionFromSize,
        errorCorrectionLevel,
        bounds: {
          x: 0,
          y: 0,
          width: size,
          height: size,
        },
        corners: {
          topLeft: { x: 0, y: 0 },
          topRight: { x: size, y: 0 },
          bottomRight: { x: size, y: size },
          bottomLeft: { x: 0, y: size },
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
    case 'gbk':
      return GBK_DECODER.decode(bytes);
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
    text += reader.read(10).toString().padStart(3, '0');
    remaining -= 3;
  }

  if (remaining === 2) {
    text += reader.read(7).toString().padStart(2, '0');
  } else if (remaining === 1) {
    text += reader.read(4).toString();
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
      return 'gbk';
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
 * @param reserved - Function-module reservation mask.
 * @returns Data bits in QR scan order.
 */
const extractDataBits = (matrix: boolean[][], reserved: boolean[][]): number[] => {
  const positions = buildDataModulePositions(matrix.length, reserved);
  const bits: number[] = [];

  for (const [row, col] of positions) {
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

      return {
        dataCodewords: Array.from(corrected.slice(0, block.dataCodewords.length)),
        ecCodewords: Array.from(corrected.slice(block.dataCodewords.length)),
      };
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
    result.push(...block.dataCodewords);
  }

  return result;
};
