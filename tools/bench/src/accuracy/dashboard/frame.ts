import type { BenchDashboardModel } from './model.js';
import { renderScorecard } from './scorecard.js';
import {
  renderActiveWorkers,
  renderRecentScans,
  renderSideBySide,
  renderSlowestFreshScans,
} from './tables.js';
import { renderTimingChart } from './timing-chart.js';

const FOOTER_ROWS = 1;
const SECTION_SPACING_ROWS = 1;
const MIN_RECENT_SCAN_ROWS = 4;

export const renderRunFooter = (dashboard: BenchDashboardModel): string => {
  let cacheHits = 0;
  let cacheMisses = 0;
  let cacheWrites = 0;
  for (const engine of dashboard.engines.values()) {
    cacheHits += engine.cacheHits;
    cacheMisses += engine.cacheMisses;
    cacheWrites += engine.cacheWrites;
  }

  return [
    `bench accuracy`,
    `stage=${dashboard.stage}`,
    dashboard.message,
    `jobs=${dashboard.completedJobs}/${dashboard.totalJobs}`,
    `assets=${dashboard.preparedAssets}/${dashboard.assetCount}`,
    `workers=${dashboard.workerCount || '-'}`,
    `cache=${dashboard.cacheEnabled ? 'on' : 'off'}:${cacheHits}/${cacheMisses}/${cacheWrites}`,
  ].join(' | ');
};

export const renderDashboardFrame = (
  dashboard: BenchDashboardModel,
  options: {
    readonly width: number;
    readonly height: number;
    readonly nowMs?: number;
  },
): string => {
  const width = options.width;
  const lines: string[] = [];
  lines.push(...renderTimingChart(dashboard, { width }));
  lines.push('');
  lines.push(...renderScorecard(dashboard, { width }));
  lines.push('');

  const activeWorkers = renderActiveWorkers(dashboard, {
    width: Math.floor(width / 2),
    nowMs: options.nowMs ?? Date.now(),
  });
  const slowest = renderSlowestFreshScans(dashboard, { width: Math.floor(width / 2) });
  lines.push(...renderSideBySide(activeWorkers, slowest, { width }));
  lines.push('');

  const usedRows = lines.length + SECTION_SPACING_ROWS + FOOTER_ROWS;
  lines.push(
    ...renderRecentScans(dashboard, {
      width,
      maxRows: Math.max(MIN_RECENT_SCAN_ROWS, options.height - usedRows - SECTION_SPACING_ROWS),
    }),
  );
  lines.push('');
  lines.push(renderRunFooter(dashboard));

  return lines.join('\n');
};
