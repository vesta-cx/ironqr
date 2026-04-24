import type { BenchDashboardModel } from './model.js';
import { renderScorecard } from './scorecard.js';
import {
  renderActiveWorkers,
  renderRecentScans,
  renderSideBySide,
  renderSlowestFreshScans,
} from './tables.js';
import { renderTimingChart } from './timing-chart.js';

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

  const usedRows = lines.length + 2;
  lines.push(
    ...renderRecentScans(dashboard, {
      width,
      maxRows: Math.max(4, options.height - usedRows - 2),
    }),
  );
  lines.push('');
  lines.push(renderRunFooter(dashboard));

  return lines.join('\n');
};
