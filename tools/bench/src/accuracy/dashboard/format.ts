export const padRight = (value: string, width: number): string => {
  if (value.length >= width) return value.slice(0, width);
  return `${value}${' '.repeat(width - value.length)}`;
};

export const padLeft = (value: string, width: number): string => {
  if (value.length >= width) return value.slice(0, width);
  return `${' '.repeat(width - value.length)}${value}`;
};

export const center = (value: string, width: number): string => {
  if (value.length >= width) return value.slice(0, width);
  const left = Math.floor((width - value.length) / 2);
  return `${' '.repeat(left)}${value}${' '.repeat(width - value.length - left)}`;
};

export const truncate = (value: string, width: number): string => {
  if (width <= 0) return '';
  if (value.length <= width) return value;
  if (width === 1) return '…';
  return `${value.slice(0, width - 1)}…`;
};

export const formatCompactDuration = (durationMs: number | null): string => {
  if (durationMs === null || !Number.isFinite(durationMs)) return '-';
  if (durationMs < 1000) return `${Math.max(1, Math.round(durationMs))}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  return `${Math.round(seconds)}s`;
};

export const formatPercent = (value: number): string => {
  if (!Number.isFinite(value)) return '-';
  return `${(value * 100).toFixed(1)}%`;
};
