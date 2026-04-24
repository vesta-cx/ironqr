import process from 'node:process';
import type { BenchDashboardModel } from './dashboard/model.js';
import {
  createBenchDashboardModel,
  onDashboardAssetPrepared,
  onDashboardAssetsStarted,
  onDashboardBenchmarkStarted,
  onDashboardDone,
  onDashboardImageLoadFinished,
  onDashboardImageLoadStarted,
  onDashboardManifestLoaded,
  onDashboardManifestStarted,
  onDashboardScanFinished,
  onDashboardScanStarted,
} from './dashboard/model.js';
import { renderScorecard } from './dashboard/scorecard.js';
import {
  renderActiveWorkers,
  renderRecentScans,
  renderSideBySide,
  renderSlowestFreshScans,
} from './dashboard/tables.js';
import { renderTimingChart } from './dashboard/timing-chart.js';
import type { EngineAssetResult } from './types.js';

export type AccuracyProgressMode = 'auto' | 'plain' | 'dashboard' | 'off';

export interface AccuracyProgressReporter {
  onManifestStarted: () => void;
  onManifestLoaded: (
    assetCount: number,
    engineIds: readonly string[],
    cacheEnabled: boolean,
    totals?: { readonly positiveCount: number; readonly negativeCount: number },
  ) => void;
  onAssetsStarted: (assetCount: number) => void;
  onAssetPrepared: (assetId: string, prepared: number, total: number) => void;
  onBenchmarkStarted: (
    assetCount: number,
    engineIds: readonly string[],
    workerCount: number,
  ) => void;
  onScanStarted: (event: {
    readonly engineId: string;
    readonly assetId: string;
    readonly relativePath: string;
    readonly cached: boolean;
    readonly cacheable: boolean;
  }) => void;
  onImageLoadStarted: (event: {
    readonly engineId: string;
    readonly assetId: string;
    readonly relativePath: string;
  }) => void;
  onImageLoadFinished: (event: {
    readonly engineId: string;
    readonly assetId: string;
    readonly width: number;
    readonly height: number;
  }) => void;
  onScanFinished: (event: {
    readonly engineId: string;
    readonly assetId: string;
    readonly relativePath: string;
    readonly result: EngineAssetResult;
    readonly wroteToCache: boolean;
  }) => void;
  stop: () => void;
}

const formatDuration = (value: number | null): string =>
  value === null ? '-' : `${value.toFixed(2)}ms`;

const now = (): string => new Date().toISOString().slice(11, 19);

const renderRunFooter = (dashboard: BenchDashboardModel): string => {
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

const formatIronqrDiagnostics = (result: EngineAssetResult): string | null => {
  const diagnostics = result.diagnostics;
  if (!diagnostics || diagnostics.kind !== 'ironqr-trace') return null;
  const clustering = diagnostics.clustering;
  const finished = diagnostics.scanFinished;
  const started = diagnostics.counts['decode-attempt-started'] ?? 0;
  return [
    `trace=${diagnostics.traceMode}`,
    clustering
      ? `proposals=${clustering.rankedProposalCount}/${clustering.boundedProposalCount}`
      : null,
    clustering ? `clusters=${clustering.clusterCount}` : null,
    clustering ? `reps=${clustering.representativeCount}` : null,
    finished ? `processedReps=${finished.processedRepresentativeCount}` : null,
    finished ? `killedClusters=${finished.killedClusterCount}` : null,
    `clusterOutcomes=${diagnostics.clusterOutcomes.decoded}/${diagnostics.clusterOutcomes.duplicate}/${diagnostics.clusterOutcomes.killed}/${diagnostics.clusterOutcomes.exhausted}`,
    `attempts=${started}`,
    `timingFails=${diagnostics.attemptFailures.timingCheck}`,
    `decodeFails=${diagnostics.attemptFailures.decodeFailed}`,
  ]
    .filter((part): part is string => part !== null)
    .join(' ');
};

export const createAccuracyProgressReporter = (options: {
  readonly enabled: boolean;
  readonly mode?: AccuracyProgressMode;
  readonly verbose?: boolean;
  readonly stderr?: NodeJS.WriteStream;
}): AccuracyProgressReporter => {
  const stderr = options.stderr ?? process.stderr;
  const mode = options.enabled ? (options.mode ?? 'auto') : 'off';
  const enabled = mode !== 'off';
  const verbose = options.verbose ?? false;
  const wantsDashboard = mode === 'dashboard' || (mode === 'auto' && stderr.isTTY);
  const useTui = enabled && stderr.isTTY && wantsDashboard;
  const usePlainLogs = enabled && !useTui;

  let renderQueued = false;
  let stopped = false;
  const dashboard = createBenchDashboardModel();

  const logPlain = (line: string): void => {
    if (!usePlainLogs) return;
    stderr.write(`[bench ${now()}] ${line}\n`);
  };

  const queueRender = (): void => {
    if (!useTui || renderQueued || stopped) return;
    renderQueued = true;
    queueMicrotask(() => {
      renderQueued = false;
      render();
    });
  };

  const render = (): void => {
    if (!useTui || stopped) return;
    const lines: string[] = [];
    const width = stderr.columns ?? 120;
    lines.push(...renderTimingChart(dashboard, { width }));
    lines.push('');
    lines.push(...renderScorecard(dashboard, { width }));
    lines.push('');
    const activeWorkers = renderActiveWorkers(dashboard, {
      width: Math.floor(width / 2),
      nowMs: Date.now(),
    });
    const slowest = renderSlowestFreshScans(dashboard, { width: Math.floor(width / 2) });
    lines.push(...renderSideBySide(activeWorkers, slowest, { width }));
    lines.push('');
    const usedRows = lines.length + 2;
    const terminalRows = stderr.rows ?? 40;
    lines.push(
      ...renderRecentScans(dashboard, {
        width,
        maxRows: Math.max(4, terminalRows - usedRows - 2),
      }),
    );
    lines.push('');
    lines.push(renderRunFooter(dashboard));

    stderr.write(`\u001B[H\u001B[J${lines.join('\n')}\n`);
  };

  if (useTui) {
    stderr.write('\u001B[?1049h\u001B[?25l');
    queueRender();
  }

  return {
    onManifestStarted: () => {
      onDashboardManifestStarted(dashboard);
      logPlain('stage manifest: reading approved corpus manifest');
      queueRender();
    },
    onManifestLoaded: (nextAssetCount, engineIds, nextCacheEnabled, totals) => {
      onDashboardManifestLoaded(dashboard, nextAssetCount, engineIds, nextCacheEnabled, totals);
      logPlain(
        `stage manifest: loaded ${nextAssetCount} approved assets and ${engineIds.length} engines`,
      );
      queueRender();
    },
    onAssetsStarted: (nextAssetCount) => {
      onDashboardAssetsStarted(dashboard, nextAssetCount);
      logPlain(`stage assets: preparing ${nextAssetCount} lazy asset descriptors`);
      queueRender();
    },
    onAssetPrepared: (assetId, prepared, total) => {
      onDashboardAssetPrepared(dashboard, assetId, prepared, total);
      if (!useTui && (prepared === total || prepared % 10 === 0)) {
        logPlain(`stage assets: prepared ${prepared}/${total} (${assetId})`);
      }
      queueRender();
    },
    onBenchmarkStarted: (nextAssetCount, engineIds, nextWorkerCount) => {
      onDashboardBenchmarkStarted(dashboard, nextAssetCount, engineIds, nextWorkerCount);
      logPlain(
        `stage benchmark: running ${nextAssetCount * engineIds.length} engine jobs across ${nextWorkerCount} workers`,
      );
      queueRender();
    },
    onScanStarted: ({ engineId, assetId, relativePath, cached, cacheable }) => {
      onDashboardScanStarted(dashboard, { engineId, assetId, relativePath, cached, cacheable });
      if (!useTui) {
        if (cached) {
          logPlain(`cache hit: ${engineId} ${assetId} ${relativePath}`);
        } else {
          logPlain(`scan start: ${engineId} ${assetId} ${relativePath}${cacheable ? '' : ' live'}`);
        }
      }
      queueRender();
    },
    onImageLoadStarted: ({ engineId, assetId, relativePath }) => {
      onDashboardImageLoadStarted(dashboard, { engineId, assetId, relativePath });
      if (!useTui) {
        logPlain(`image load: ${engineId} ${assetId} ${relativePath}`);
      }
      queueRender();
    },
    onImageLoadFinished: ({ engineId, assetId, width, height }) => {
      onDashboardImageLoadFinished(dashboard, { engineId, assetId });
      if (!useTui) {
        logPlain(`image ready: ${engineId} ${assetId} ${width}x${height}`);
      }
      queueRender();
    },
    onScanFinished: ({ engineId, assetId, relativePath, result, wroteToCache }) => {
      onDashboardScanFinished(dashboard, { engineId, assetId, relativePath, result, wroteToCache });
      if (!useTui) {
        logPlain(
          `scan finish: ${engineId} ${assetId} ${result.outcome} ${formatDuration(result.durationMs)} ${result.cached ? 'cached' : 'fresh'}`,
        );
        if (verbose) {
          const diagnosticsLine = formatIronqrDiagnostics(result);
          if (diagnosticsLine) {
            logPlain(`scan diag: ${engineId} ${assetId} ${diagnosticsLine}`);
          }
        }
      }
      queueRender();
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      onDashboardDone(dashboard);
      if (useTui) {
        render();
        stderr.write('\u001B[?25h\u001B[?1049l');
      }
      stopped = true;
    },
  };
};
