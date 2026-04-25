import { formatCompactDuration, padLeft, padRight, truncate } from './format.js';
import type { BenchDashboardModel, RecentScan, SlowScan } from './model.js';

export type StudySlowestMetric = 'avg' | 'p85' | 'p95' | 'p98' | 'p99' | 'max';

export interface StudyTimingFilters {
  readonly families: ReadonlySet<string>;
  readonly scalars: ReadonlySet<string>;
  readonly thresholds: ReadonlySet<string>;
  readonly polarities: ReadonlySet<string>;
  readonly cache: ReadonlySet<string>;
}

export interface TableWidgetOptions {
  readonly width: number;
  readonly nowMs?: number;
  readonly maxRows?: number;
  readonly offset?: number;
  readonly studySlowestMetric?: StudySlowestMetric;
  readonly studyTimingFilters?: StudyTimingFilters;
}

export const renderActiveWorkers = (
  model: BenchDashboardModel,
  options: TableWidgetOptions,
): readonly string[] => {
  const width = options.width;
  const nowMs = options.nowMs ?? Date.now();
  const offset = Math.max(0, options.offset ?? 0);
  const rows = [...model.activeScans.values()].slice(
    offset,
    offset + normalizeMaxRows(options.maxRows, Math.max(1, model.workerCount || 8)),
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
        `${padLeft(String(offset + index + 1), 2)}      ${padRight(scan.engineId, 9)}  ${padRight(truncate(scan.assetId, 18), 18)} ${padRight(scan.label ? labelText(scan.label) : '-', 5)}  ${padLeft(elapsed, 7)}  ${scan.phase}`,
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
  const offset = Math.max(0, options.offset ?? 0);
  const rows = model.slowestFreshScans.slice(offset, offset + normalizeMaxRows(options.maxRows, 8));
  const lines = [
    model.commandName === 'study' ? 'slowest study units' : 'slowest fresh scans',
    truncate(
      model.commandName === 'study'
        ? `#  detector/view                         ${options.studySlowestMetric ?? 'p98'}     jobs`
        : '#  engine     time      outcome      asset',
      width,
    ),
  ];
  if (model.commandName === 'study') {
    const metric = options.studySlowestMetric ?? 'p98';
    const studyRows = [...model.studyDetectorTimings.values(), ...model.studyTimings.values()]
      .filter((row) => matchesStudyTimingFilters(row, options.studyTimingFilters))
      .sort((left, right) => studyTimingMetric(right, metric) - studyTimingMetric(left, metric))
      .slice(offset, offset + normalizeMaxRows(options.maxRows, 8));
    if (studyRows.length === 0) {
      lines.push(truncate('none yet', width));
      return lines;
    }
    for (const [index, row] of studyRows.entries()) {
      const metricMs = studyTimingMetric(row, metric);
      lines.push(
        truncate(
          `${padLeft(String(offset + index + 1), 2)} ${padRight(row.id, 35)} ${padLeft(formatCompactDuration(metricMs), 7)} ${row.count} c=${row.cachedCount}`,
          width,
        ),
      );
    }
    return lines;
  }
  if (rows.length === 0) {
    lines.push(truncate('none yet', width));
    return lines;
  }

  for (const [index, scan] of rows.entries()) {
    lines.push(truncate(renderSlowScan(offset + index + 1, scan), width));
  }
  return lines;
};

export const renderRecentScans = (
  model: BenchDashboardModel,
  options: TableWidgetOptions,
): readonly string[] => {
  const width = options.width;
  const maxRows = normalizeMaxRows(options.maxRows, 8);
  const rows = maxRows === 0 ? [] : model.recentScans.slice(-maxRows);
  const lines = [
    model.commandName === 'study' ? 'recent study assets' : 'recent scans',
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

const matchesStudyTimingFilters = (
  row: { readonly id: string; readonly count: number; readonly cachedCount: number },
  filters: StudyTimingFilters | undefined,
): boolean => {
  if (!filters) return true;
  const parts = parseStudyTimingId(row.id);
  return (
    matchesFilter(filters.families, parts.family) &&
    matchesFilter(filters.scalars, parts.scalar) &&
    matchesFilter(filters.thresholds, parts.threshold) &&
    matchesFilter(filters.polarities, parts.polarity) &&
    matchesCacheFilter(filters.cache, row)
  );
};

const parseStudyTimingId = (
  id: string,
): {
  readonly family: string;
  readonly scalar: string;
  readonly threshold: string;
  readonly polarity: string;
} => {
  const parts = id.split(':');
  return {
    family: parts.length >= 5 ? (parts[1] ?? '') : (parts[0] ?? ''),
    scalar: parts.at(-3) ?? '',
    threshold: parts.at(-2) ?? '',
    polarity: parts.at(-1) ?? '',
  };
};

const matchesFilter = (selected: ReadonlySet<string>, value: string): boolean =>
  selected.size === 0 || selected.has(value);

const matchesCacheFilter = (
  selected: ReadonlySet<string>,
  row: { readonly count: number; readonly cachedCount: number },
): boolean => {
  if (selected.size === 0) return true;
  const fresh = row.count - row.cachedCount;
  const states = new Set<string>();
  if (fresh > 0) states.add('fresh');
  if (row.cachedCount > 0) states.add('cached');
  if (fresh > 0 && row.cachedCount > 0) states.add('mixed');
  return [...selected].some((entry) => states.has(entry));
};

const studyTimingMetric = (
  row: {
    readonly totalMs: number;
    readonly count: number;
    readonly maxMs: number;
    readonly samples: readonly number[];
  },
  metric: StudySlowestMetric,
): number => {
  if (metric === 'avg') return row.totalMs / Math.max(1, row.count);
  if (metric === 'max') return row.maxMs;
  if (metric === 'p85') return percentile(row.samples, 0.85);
  if (metric === 'p98') return percentile(row.samples, 0.98);
  if (metric === 'p99') return percentile(row.samples, 0.99);
  return percentile(row.samples, 0.95);
};

const percentile = (values: readonly number[], quantile: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? 0;
};

const renderSlowScan = (rank: number, scan: SlowScan): string => {
  return `${padLeft(String(rank), 2)} ${padRight(scan.engineId, 9)}  ${padLeft(formatCompactDuration(scan.durationMs), 8)}  ${padRight(scan.outcome, 12)} ${truncate(scan.assetId, 18)}`;
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

const labelText = (label: 'qr-pos' | 'qr-neg'): string => {
  return label === 'qr-pos' ? '+QR' : '-NEG';
};

const timeText = (timestampMs: number): string => {
  return new Date(timestampMs).toISOString().slice(11, 19);
};

const normalizeMaxRows = (value: number | undefined, fallback: number): number => {
  const candidate = value ?? fallback;
  if (!Number.isFinite(candidate)) return fallback;
  return Math.max(0, Math.floor(candidate));
};
