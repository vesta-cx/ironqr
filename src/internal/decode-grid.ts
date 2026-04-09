import type { DecodeGridResult } from '../contracts/index.js';
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
import { correctRsBlock } from './reed-solomon.js';

const LATIN1_DECODER = new TextDecoder('iso-8859-1', { fatal: false });
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });
const SHIFT_JIS_DECODER = new TextDecoder('shift_jis', { fatal: false });
const ASCII_DECODER = new TextDecoder('us-ascii', { fatal: false });
const UTF16BE_DECODER = new TextDecoder('utf-16be', { fatal: false });
const BIG5_DECODER = new TextDecoder('big5', { fatal: false });
const GBK_DECODER = new TextDecoder('gbk', { fatal: false });
const EUC_KR_DECODER = new TextDecoder('euc-kr', { fatal: false });

class BitReader {
  private readonly bits: number[];
  private index = 0;

  constructor(bytes: readonly number[]) {
    const bits: number[] = [];
    for (const byte of bytes) {
      for (let bit = 7; bit >= 0; bit -= 1) {
        bits.push((byte >> bit) & 1);
      }
    }
    this.bits = bits;
  }

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

  remaining(): number {
    return this.bits.length - this.index;
  }
}

function classifyPayload(
  text: string,
): 'text' | 'url' | 'email' | 'sms' | 'wifi' | 'contact' | 'calendar' | 'binary' | 'unknown' {
  if (/^https?:\/\//i.test(text)) {
    return 'url';
  }

  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
    return 'email';
  }

  return 'text';
}

function decodeText(bytes: Uint8Array, encoding: string): string {
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
}

function decodeAlphanumeric(reader: BitReader, count: number): string {
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
}

function decodeNumeric(reader: BitReader, count: number): string {
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
}

function decodeByteSegment(reader: BitReader, count: number): Uint8Array {
  const bytes = new Uint8Array(count);
  for (let index = 0; index < count; index += 1) {
    bytes[index] = reader.read(8);
  }

  return bytes;
}

function decodeKanjiSegment(reader: BitReader, count: number): Uint8Array {
  const bytes = new Uint8Array(count * 2);

  for (let index = 0; index < count; index += 1) {
    const value = reader.read(13);
    let sjis = (Math.floor(value / 0xc0) << 8) | (value % 0xc0);
    sjis += sjis < 0x1f00 ? 0x8140 : 0xc140;
    bytes[index * 2] = (sjis >> 8) & 0xff;
    bytes[index * 2 + 1] = sjis & 0xff;
  }

  return bytes;
}

function readEciAssignmentNumber(reader: BitReader): number {
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
}

function getEciEncodingLabel(assignmentNumber: number): string {
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
}

function decodePayloadFromDataCodewords(
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
} {
  const reader = new BitReader(dataCodewords);
  const headers: Array<readonly [string, string]> = [];
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

  while (reader.remaining() >= 4) {
    const mode = reader.read(4);
    if (mode === 0) {
      break;
    }

    if (mode === 0b0010) {
      const count = reader.read(alphanumericCountBits);
      const segmentText = decodeAlphanumeric(reader, count);
      text += segmentText;
      bytes.push(...new TextEncoder().encode(segmentText));
      payloadKind = classifyPayload(text);
      headers.push(['mode', 'alphanumeric']);
      continue;
    }

    if (mode === 0b0100) {
      const count = reader.read(byteCountBits);
      const segment = decodeByteSegment(reader, count);
      bytes.push(...segment);
      const segmentText = decodeText(segment, currentEncoding);
      text += segmentText;
      payloadKind = classifyPayload(text);
      headers.push(['mode', 'byte']);
      continue;
    }

    if (mode === 0b0001) {
      const count = reader.read(numericCountBits);
      const segmentText = decodeNumeric(reader, count);
      text += segmentText;
      bytes.push(...new TextEncoder().encode(segmentText));
      payloadKind = classifyPayload(text);
      headers.push(['mode', 'numeric']);
      continue;
    }

    if (mode === 0b1000) {
      const count = reader.read(kanjiCountBits);
      const segment = decodeKanjiSegment(reader, count);
      bytes.push(...segment);
      const segmentText = decodeText(segment, 'shift_jis');
      text += segmentText;
      payloadKind = classifyPayload(text);
      headers.push(['mode', 'kanji']);
      continue;
    }

    if (mode === 0b0111) {
      const assignmentNumber = readEciAssignmentNumber(reader);
      currentEncoding = getEciEncodingLabel(assignmentNumber);
      headers.push(['mode', 'eci']);
      headers.push(['encoding', currentEncoding]);
      continue;
    }

    if (mode === 0b0101) {
      headers.push(['mode', 'fnc1-first']);
      continue;
    }

    if (mode === 0b1001) {
      headers.push(['mode', 'fnc1-second']);
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
  };
}

function bytesFromBits(bits: readonly number[]): Uint8Array {
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
}

function extractDataBits(matrix: boolean[][], reserved: boolean[][]): number[] {
  const positions = buildDataModulePositions(matrix.length, reserved);
  const bits: number[] = [];

  for (const [row, col] of positions) {
    bits.push(matrix[row]?.[col] ? 1 : 0);
  }

  return bits;
}

interface RawBlock {
  readonly dataCodewords: number[];
  readonly ecCodewords: number[];
}

function splitInterleavedCodewords(
  codewords: readonly number[],
  blockInfo: ReturnType<typeof getVersionBlockInfo>,
): RawBlock[] {
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
}

function correctAndReinterleaveDataCodewords(blocks: RawBlock[]): number[] {
  const correctedBlocks = blocks.map((block) => {
    const corrected = correctRsBlock(
      [...block.dataCodewords, ...block.ecCodewords],
      block.ecCodewords.length,
    );

    return {
      dataCodewords: Array.from(corrected.slice(0, block.dataCodewords.length)),
      ecCodewords: Array.from(corrected.slice(block.dataCodewords.length)),
    };
  });

  const maxDataCodewords = Math.max(
    ...correctedBlocks.map((block) => block.dataCodewords.length),
    0,
  );
  const result: number[] = [];

  for (let index = 0; index < maxDataCodewords; index += 1) {
    for (const block of correctedBlocks) {
      if (index < block.dataCodewords.length) {
        result.push(block.dataCodewords[index] ?? 0);
      }
    }
  }

  return result;
}

export async function decodeGridLogical(input: {
  readonly grid: readonly (readonly boolean[])[];
}): Promise<DecodeGridResult> {
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
  };
}
