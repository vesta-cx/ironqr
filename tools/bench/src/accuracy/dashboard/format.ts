const ESCAPE = String.fromCharCode(27);
const ANSI_ESCAPE = new RegExp(`${ESCAPE}\\[[0-?]*[ -/]*[@-~]`, 'g');
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export const sanitizeDisplayText = (value: string): string => {
  let output = '';
  for (const grapheme of graphemes(value.replace(ANSI_ESCAPE, ''))) {
    if (isControlOnly(grapheme)) continue;
    output += grapheme;
  }
  return output;
};

export const padRight = (value: string, width: number): string => {
  const normalizedWidth = normalizeWidth(width);
  if (normalizedWidth === 0) return '';
  const truncated = truncateToWidth(value, normalizedWidth);
  return `${truncated}${' '.repeat(normalizedWidth - displayWidth(truncated))}`;
};

export const padLeft = (value: string, width: number): string => {
  const normalizedWidth = normalizeWidth(width);
  if (normalizedWidth === 0) return '';
  const truncated = truncateToWidth(value, normalizedWidth);
  return `${' '.repeat(normalizedWidth - displayWidth(truncated))}${truncated}`;
};

export const center = (value: string, width: number): string => {
  const normalizedWidth = normalizeWidth(width);
  if (normalizedWidth === 0) return '';
  const truncated = truncateToWidth(value, normalizedWidth);
  const left = Math.floor((normalizedWidth - displayWidth(truncated)) / 2);
  return `${' '.repeat(left)}${truncated}${' '.repeat(normalizedWidth - displayWidth(truncated) - left)}`;
};

export const truncate = (value: string, width: number): string => {
  const normalizedWidth = normalizeWidth(width);
  if (normalizedWidth === 0) return '';
  const sanitized = sanitizeDisplayText(value);
  if (displayWidth(sanitized) <= normalizedWidth) return sanitized;
  if (normalizedWidth === 1) return '…';
  return `${truncateToWidth(sanitized, normalizedWidth - 1)}…`;
};

export const formatCompactDuration = (durationMs: number | null): string => {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return '-';
  if (durationMs === 0) return '0ms';
  if (durationMs < 1000) return `${Math.max(1, Math.round(durationMs))}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  return `${Math.round(seconds)}s`;
};

export const formatPercent = (value: number): string => {
  if (!Number.isFinite(value)) return '-';
  return `${(value * 100).toFixed(1)}%`;
};

const normalizeWidth = (width: number): number => {
  if (!Number.isFinite(width) || width <= 0) return 0;
  return Math.floor(width);
};

const truncateToWidth = (value: string, width: number): string => {
  let output = '';
  let used = 0;
  for (const segment of graphemes(sanitizeDisplayText(value))) {
    const nextWidth = graphemeWidth(segment);
    if (used + nextWidth > width) break;
    output += segment;
    used += nextWidth;
  }
  return output;
};

const displayWidth = (value: string): number => {
  let width = 0;
  for (const segment of graphemes(value)) {
    width += graphemeWidth(segment);
  }
  return width;
};

const graphemes = (value: string): string[] => {
  return [...segmenter.segment(value)].map((segment) => segment.segment);
};

const graphemeWidth = (value: string): number => {
  if (value.length === 0) return 0;
  if (isCombiningOnly(value)) return 0;
  const codePoint = value.codePointAt(0) ?? 0;
  if (isFullWidth(codePoint) || /\p{Emoji_Presentation}/u.test(value)) return 2;
  return 1;
};

const isControlOnly = (value: string): boolean => {
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (!isControlCodePoint(codePoint)) return false;
  }
  return true;
};

const isControlCodePoint = (codePoint: number): boolean => {
  return (codePoint >= 0x00 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f);
};

const isCombiningOnly = (value: string): boolean => /^\p{Mark}+$/u.test(value);

const isFullWidth = (codePoint: number): boolean => {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6)
  );
};
