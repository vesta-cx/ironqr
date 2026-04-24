import { formatCompactDuration, formatPercent, padLeft, padRight, truncate } from './format.js';
import { averageTimingMs, type BenchDashboardModel, type DashboardEngineStats } from './model.js';

export interface ScorecardOptions {
  readonly width: number;
}

const COLUMNS = {
  engine: 11,
  qrPass: 27,
  qrFail: 19,
  negativePass: 27,
  negativeFail: 12,
  cache: 11,
} as const;

export const renderScorecard = (
  model: BenchDashboardModel,
  options: ScorecardOptions,
): readonly string[] => {
  const lines = ['scorecard'];
  const header = joinColumns([
    padRight('engine', COLUMNS.engine),
    padRight('QR pass', COLUMNS.qrPass),
    padRight('QR fail', COLUMNS.qrFail),
    padRight('neg pass', COLUMNS.negativePass),
    padRight('neg fail', COLUMNS.negativeFail),
    padRight('cache', COLUMNS.cache),
  ]);
  lines.push(truncate(header, options.width));

  for (const engineId of model.engineOrder) {
    const engine = model.engines.get(engineId);
    lines.push(
      truncate(
        engine ? renderEngineRow(model, engine) : renderMissingEngineRow(engineId),
        options.width,
      ),
    );
  }

  return lines;
};

const renderMissingEngineRow = (engineId: string): string => {
  return joinColumns([
    padRight(engineId, COLUMNS.engine),
    padRight('missing engine state', COLUMNS.qrPass),
    padRight('-', COLUMNS.qrFail),
    padRight('-', COLUMNS.negativePass),
    padRight('-', COLUMNS.negativeFail),
    padLeft('-', COLUMNS.cache),
  ]);
};

const renderEngineRow = (model: BenchDashboardModel, engine: DashboardEngineStats): string => {
  const qrPass = engine.qrPass + engine.qrPartial;
  const qrExpected = model.positiveAssetCount;
  const negativeExpected = model.negativeAssetCount;
  const qrPassText = `${qrPass}/${qrExpected || '-'} ${percentage(qrPass, qrExpected)} avg ${formatCompactDuration(averageTimingMs(engine.timing['positive-pass']))}`;
  const qrFailText = `no_dec ${engine.qrNoDecode} mm ${engine.qrMismatch}${engine.qrErrors > 0 ? ` err ${engine.qrErrors}` : ''}`;
  const negativePassText = `${engine.negativePass}/${negativeExpected || '-'} ${percentage(engine.negativePass, negativeExpected)} avg ${formatCompactDuration(averageTimingMs(engine.timing['negative-pass']))}`;
  const negativeFailText = `fp ${engine.falsePositive}${engine.negativeErrors > 0 ? ` err ${engine.negativeErrors}` : ''}`;
  const cacheText = `${engine.cacheHits}/${engine.cacheMisses}`;

  return joinColumns([
    padRight(engine.id, COLUMNS.engine),
    padRight(qrPassText, COLUMNS.qrPass),
    padRight(qrFailText, COLUMNS.qrFail),
    padRight(negativePassText, COLUMNS.negativePass),
    padRight(negativeFailText, COLUMNS.negativeFail),
    padLeft(cacheText, COLUMNS.cache),
  ]);
};

const percentage = (actual: number, expected: number): string => {
  if (expected <= 0) return '-';
  return formatPercent(actual / expected);
};

const joinColumns = (columns: readonly string[]): string => columns.join('  ');
