import { formatCompactDuration, padLeft, padRight, truncate } from './format.js';
import type { BenchDashboardModel, RecentScan, SlowScan } from './model.js';

export interface TableWidgetOptions {
  readonly width: number;
  readonly nowMs?: number;
  readonly maxRows?: number;
}

export const renderActiveWorkers = (
  model: BenchDashboardModel,
  options: TableWidgetOptions,
): readonly string[] => {
  const width = options.width;
  const nowMs = options.nowMs ?? Date.now();
  const rows = [...model.activeScans.values()].slice(
    0,
    options.maxRows ?? Math.max(1, model.workerCount || 8),
  );
  const lines = [
    'active workers',
    truncate('worker  engine     asset              label  elapsed  state', width),
  ];
  if (rows.length === 0) {
    lines.push(truncate('idle', width));
    return lines;
  }

  for (const [index, scan] of rows.entries()) {
    const elapsed = formatCompactDuration(nowMs - scan.startedAtMs);
    lines.push(
      truncate(
        `${padLeft(String(index + 1), 2)}      ${padRight(scan.engineId, 9)}  ${padRight(truncate(scan.assetId, 18), 18)} ${padRight(scan.label ? labelText(scan.label) : '-', 5)}  ${padLeft(elapsed, 7)}  ${scan.phase}`,
        width,
      ),
    );
  }
  return lines;
};

export const renderSlowestFreshScans = (
  model: BenchDashboardModel,
  options: TableWidgetOptions,
): readonly string[] => {
  const width = options.width;
  const rows = model.slowestFreshScans.slice(0, options.maxRows ?? 8);
  const lines = [
    'slowest fresh scans',
    truncate('#  engine     time      outcome      asset', width),
  ];
  if (rows.length === 0) {
    lines.push(truncate('none yet', width));
    return lines;
  }

  for (const [index, scan] of rows.entries()) {
    lines.push(truncate(renderSlowScan(index + 1, scan), width));
  }
  return lines;
};

export const renderRecentScans = (
  model: BenchDashboardModel,
  options: TableWidgetOptions,
): readonly string[] => {
  const width = options.width;
  const maxRows = options.maxRows ?? 8;
  const rows = model.recentScans.slice(-maxRows);
  const lines = [
    'recent scans',
    truncate(
      'time      engine      asset             label  outcome       dur     cache   detail',
      width,
    ),
  ];
  if (rows.length === 0) {
    lines.push(truncate('none yet', width));
    return lines;
  }

  for (const scan of rows) {
    lines.push(truncate(renderRecentScan(scan), width));
  }
  return lines;
};

export const renderSideBySide = (
  left: readonly string[],
  right: readonly string[],
  options: { readonly width: number; readonly gap?: number },
): readonly string[] => {
  const gap = options.gap ?? 3;
  const leftWidth = Math.floor((options.width - gap) / 2);
  const rightWidth = options.width - gap - leftWidth;
  const height = Math.max(left.length, right.length);
  return Array.from({ length: height }, (_, index) => {
    const leftLine = truncate(left[index] ?? '', leftWidth);
    const rightLine = truncate(right[index] ?? '', rightWidth);
    return `${padRight(leftLine, leftWidth)}${' '.repeat(gap)}${rightLine}`;
  });
};

const renderSlowScan = (rank: number, scan: SlowScan): string => {
  return `${padLeft(String(rank), 1)}  ${padRight(scan.engineId, 9)}  ${padLeft(formatCompactDuration(scan.durationMs), 8)}  ${padRight(scan.outcome, 12)} ${truncate(scan.assetId, 18)}`;
};

const renderRecentScan = (scan: RecentScan): string => {
  return `${timeText(scan.finishedAtMs)}  ${padRight(scan.engineId, 10)}  ${padRight(truncate(scan.assetId, 17), 17)} ${padRight(labelText(scan.result.label), 5)}  ${padRight(scan.result.outcome, 12)} ${padLeft(formatCompactDuration(scan.result.durationMs), 7)} ${scan.result.cached ? 'hit  ' : 'fresh'}   ${recentDetail(scan)}`;
};

const recentDetail = (scan: RecentScan): string => {
  const diagnostics = scan.result.diagnostics;
  const matched = scan.result.matchedTexts.length;
  const decoded = scan.result.decodedTexts.length;
  const base = `decoded=${decoded} matched=${matched}`;
  if (!diagnostics || diagnostics.kind !== 'ironqr-trace') return base;
  const attempts = diagnostics.counts['decode-attempt-started'] ?? 0;
  return `${base} attempts=${attempts} timing=${diagnostics.attemptFailures.timingCheck} decode=${diagnostics.attemptFailures.decodeFailed}`;
};

const labelText = (label: 'qr-positive' | 'non-qr-negative'): string => {
  return label === 'qr-positive' ? '+QR' : '-NEG';
};

const timeText = (timestampMs: number): string => {
  return new Date(timestampMs).toISOString().slice(11, 19);
};
