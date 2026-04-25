import { center, formatCompactDuration, padRight } from './format.js';
import {
  averageTimingMs,
  type BenchDashboardModel,
  type DashboardEngineStats,
  type TimingBucketKey,
  timingBucketKeys,
} from './model.js';

export interface TimingChartOptions {
  readonly width: number;
  readonly engineOffset?: number;
  readonly barHeight?: number;
}

const BUCKET_LABELS: Record<TimingBucketKey, string> = {
  'positive-pass': 'P',
  'positive-fail': 'F',
  'negative-pass': 'N',
  'negative-fail': 'X',
};

const BUCKET_WIDTH = 4;
const BUCKET_GAP = ' ';
const ENGINE_GAP = '    ';
const ROW_LABEL_WIDTH = 10;
const BAR_HEIGHT = 6;
const FILLED_BAR = '███';
const EMPTY_BAR = '   ';
const NO_SAMPLE_BAR = '   ';
const CACHE_ONLY_BAR = ' c ';

export const renderTimingChart = (
  model: BenchDashboardModel,
  options: TimingChartOptions,
): readonly string[] => {
  const barHeight = options.barHeight ?? BAR_HEIGHT;
  const engineGroupWidth = bucketGroupWidth();
  const visibleWidth = Math.max(0, options.width - ROW_LABEL_WIDTH);
  const maxVisibleEngines = Math.max(
    1,
    Math.floor((visibleWidth + ENGINE_GAP.length) / (engineGroupWidth + ENGINE_GAP.length)),
  );
  const maxOffset = Math.max(0, model.engineOrder.length - maxVisibleEngines);
  const engineOffset = Math.min(Math.max(0, options.engineOffset ?? 0), maxOffset);
  const engines = model.engineOrder
    .slice(engineOffset, engineOffset + maxVisibleEngines)
    .map((engineId) => model.engines.get(engineId))
    .filter((engine): engine is DashboardEngineStats => engine !== undefined);

  const lines = [
    'avg fresh ms / asset',
    `legend: P=QR pass  F=QR fail  N=NEG pass  X=NEG fail  c=cache hits${viewportLabel(model.engineOrder.length, engineOffset, engines.length)}`,
    '',
  ];
  if (engines.length === 0) return lines;

  const scaleMax = maxAverageMs(model);
  lines.push(
    `${' '.repeat(ROW_LABEL_WIDTH)}${joinEngineGroups(engines.map((engine) => center(engine.id, engineGroupWidth)))}`,
  );
  lines.push(`${' '.repeat(ROW_LABEL_WIDTH)}${joinEngineGroups(engines.map(renderBucketLabels))}`);

  for (let row = barHeight; row >= 1; row -= 1) {
    lines.push(
      `${' '.repeat(ROW_LABEL_WIDTH)}${joinEngineGroups(engines.map((engine) => renderBarRow(engine, row, barHeight, scaleMax)))}`,
    );
  }

  lines.push(
    `${padRight('avg', ROW_LABEL_WIDTH)}${joinEngineGroups(engines.map(renderAverageRow))}`,
  );
  lines.push(`${padRight('n', ROW_LABEL_WIDTH)}${joinEngineGroups(engines.map(renderCountRow))}`);
  lines.push(`${padRight('c', ROW_LABEL_WIDTH)}${joinEngineGroups(engines.map(renderCacheRow))}`);
  return lines;
};

const viewportLabel = (totalEngines: number, offset: number, visibleCount: number): string => {
  if (totalEngines === 0 || visibleCount === 0) return '';
  const start = Math.min(totalEngines, offset + 1);
  const end = Math.min(totalEngines, offset + visibleCount);
  return `       ◀ engines ${start}-${end}/${totalEngines} ▶`;
};

const renderBucketLabels = (): string => {
  return timingBucketKeys()
    .map((key) => center(BUCKET_LABELS[key], BUCKET_WIDTH))
    .join(BUCKET_GAP);
};

const renderBarRow = (
  engine: DashboardEngineStats,
  row: number,
  barHeight: number,
  scaleMax: number,
): string => {
  return timingBucketKeys()
    .map((key) => center(barGlyph(engine, key, row, barHeight, scaleMax), BUCKET_WIDTH))
    .join(BUCKET_GAP);
};

const barGlyph = (
  engine: DashboardEngineStats,
  key: TimingBucketKey,
  row: number,
  barHeight: number,
  scaleMax: number,
): string => {
  const bucket = engine.timing[key];
  if (bucket.count === 0) return NO_SAMPLE_BAR;
  const avgMs = averageTimingMs(bucket);
  if (avgMs === null) return row === 1 ? CACHE_ONLY_BAR : EMPTY_BAR;
  const level = Math.max(1, Math.ceil((avgMs / scaleMax) * barHeight));
  if (row > level) return EMPTY_BAR;
  return FILLED_BAR;
};

const renderAverageRow = (engine: DashboardEngineStats): string => {
  return timingBucketKeys()
    .map((key) => center(formatCompactDuration(averageTimingMs(engine.timing[key])), BUCKET_WIDTH))
    .join(BUCKET_GAP);
};

const renderCountRow = (engine: DashboardEngineStats): string => {
  return timingBucketKeys()
    .map((key) => padRight(String(engine.timing[key].count), BUCKET_WIDTH))
    .join(BUCKET_GAP);
};

const renderCacheRow = (engine: DashboardEngineStats): string => {
  return timingBucketKeys()
    .map((key) => padRight(String(engine.timing[key].cachedCount), BUCKET_WIDTH))
    .join(BUCKET_GAP);
};

const maxAverageMs = (model: BenchDashboardModel): number => {
  let max = 1;
  for (const engine of model.engines.values()) {
    for (const key of timingBucketKeys()) {
      const average = averageTimingMs(engine.timing[key]);
      if (average !== null) max = Math.max(max, average);
    }
  }
  return max;
};

const joinEngineGroups = (groups: readonly string[]): string => groups.join(ENGINE_GAP);

const bucketGroupWidth = (): number =>
  timingBucketKeys().length * BUCKET_WIDTH + (timingBucketKeys().length - 1) * BUCKET_GAP.length;
