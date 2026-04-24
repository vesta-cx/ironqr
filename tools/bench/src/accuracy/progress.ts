import process from 'node:process';
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
import { renderTimingChart } from './dashboard/timing-chart.js';
import type { EngineAssetResult } from './types.js';

type BenchmarkStage = 'manifest' | 'assets' | 'benchmark' | 'report' | 'done';

interface ProgressEngineState {
  readonly id: string;
  completed: number;
  cached: number;
  fresh: number;
  activeAssetId: string | null;
  activeRelativePath: string | null;
  imageLoadingAssetId: string | null;
  lastOutcome: string | null;
  lastDurationMs: number | null;
}

interface ProgressRecentRow {
  readonly engineId: string;
  readonly assetId: string;
  readonly relativePath: string;
  readonly outcome: string;
  readonly durationMs: number;
  readonly cached: boolean;
}

export interface AccuracyProgressReporter {
  onManifestStarted: () => void;
  onManifestLoaded: (
    assetCount: number,
    engineIds: readonly string[],
    cacheEnabled: boolean,
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

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

const formatDuration = (value: number | null): string =>
  value === null ? '-' : `${value.toFixed(2)}ms`;

const now = (): string => new Date().toISOString().slice(11, 19);

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
  readonly verbose?: boolean;
  readonly stderr?: NodeJS.WriteStream;
}): AccuracyProgressReporter => {
  const stderr = options.stderr ?? process.stderr;
  const enabled = options.enabled;
  const verbose = options.verbose ?? false;
  const useTui = enabled && stderr.isTTY;

  let stage: BenchmarkStage = 'manifest';
  let message = 'starting';
  let assetCount = 0;
  let preparedAssets = 0;
  let cacheEnabled = false;
  let cacheHits = 0;
  let cacheMisses = 0;
  let cacheWrites = 0;
  let completedJobs = 0;
  let totalJobs = 0;
  let workerCount = 0;
  let renderQueued = false;
  let stopped = false;
  const recent: ProgressRecentRow[] = [];
  const engines = new Map<string, ProgressEngineState>();
  const dashboard = createBenchDashboardModel();

  const logPlain = (line: string): void => {
    if (!enabled) return;
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
    lines.push(...renderTimingChart(dashboard, { width: stderr.columns ?? 120 }));
    lines.push('');
    lines.push('bench accuracy');
    lines.push(`stage: ${stage} — ${message}`);
    if (totalJobs > 0) {
      lines.push(
        `progress: ${completedJobs}/${totalJobs} engine jobs, ${preparedAssets}/${assetCount} assets ready`,
      );
    } else if (assetCount > 0) {
      lines.push(`progress: ${preparedAssets}/${assetCount} assets ready`);
    }
    lines.push(
      `cache: ${cacheEnabled ? 'enabled' : 'disabled'} | hits ${cacheHits} | misses ${cacheMisses} | writes ${cacheWrites}`,
    );
    if (workerCount > 0) {
      lines.push(`workers: ${workerCount}`);
    }

    const engineStates = [...engines.values()];
    if (engineStates.length > 0) {
      lines.push('');
      lines.push('engines:');
      for (const engine of engineStates) {
        const activity = engine.imageLoadingAssetId
          ? `loading ${truncate(engine.imageLoadingAssetId, 18)}`
          : engine.activeAssetId
            ? `scanning ${truncate(engine.activeAssetId, 18)}`
            : `last ${engine.lastOutcome ?? '-'} ${formatDuration(engine.lastDurationMs)}`;
        lines.push(
          `  ${engine.id.padEnd(10)} ${String(engine.completed).padStart(3)}/${String(assetCount).padEnd(3)} done | cached ${String(engine.cached).padStart(3)} | ${activity}`,
        );
      }
    }

    if (recent.length > 0) {
      lines.push('');
      lines.push('recent:');
      for (const row of recent.slice(-8)) {
        lines.push(
          `  ${row.engineId.padEnd(10)} ${truncate(row.assetId, 18).padEnd(18)} ${row.cached ? 'cache ' : 'fresh '} ${row.outcome.padEnd(12)} ${formatDuration(row.durationMs)} ${truncate(row.relativePath, 40)}`,
        );
      }
    }

    stderr.write(`\u001B[H\u001B[J${lines.join('\n')}\n`);
  };

  const ensureEngine = (engineId: string): ProgressEngineState => {
    const existing = engines.get(engineId);
    if (existing) return existing;
    const created: ProgressEngineState = {
      id: engineId,
      completed: 0,
      cached: 0,
      fresh: 0,
      activeAssetId: null,
      activeRelativePath: null,
      imageLoadingAssetId: null,
      lastOutcome: null,
      lastDurationMs: null,
    };
    engines.set(engineId, created);
    return created;
  };

  const pushRecent = (row: ProgressRecentRow): void => {
    recent.push(row);
    if (recent.length > 8) {
      recent.splice(0, recent.length - 8);
    }
  };

  if (useTui) {
    stderr.write('\u001B[?1049h\u001B[?25l');
    queueRender();
  }

  return {
    onManifestStarted: () => {
      onDashboardManifestStarted(dashboard);
      stage = 'manifest';
      message = 'reading approved corpus manifest';
      logPlain('stage manifest: reading approved corpus manifest');
      queueRender();
    },
    onManifestLoaded: (nextAssetCount, engineIds, nextCacheEnabled) => {
      onDashboardManifestLoaded(dashboard, nextAssetCount, engineIds, nextCacheEnabled);
      assetCount = nextAssetCount;
      cacheEnabled = nextCacheEnabled;
      totalJobs = nextAssetCount * engineIds.length;
      for (const engineId of engineIds) ensureEngine(engineId);
      message = `loaded ${nextAssetCount} approved assets and ${engineIds.length} engines`;
      logPlain(
        `stage manifest: loaded ${nextAssetCount} approved assets and ${engineIds.length} engines`,
      );
      queueRender();
    },
    onAssetsStarted: (nextAssetCount) => {
      onDashboardAssetsStarted(dashboard, nextAssetCount);
      stage = 'assets';
      assetCount = nextAssetCount;
      message = `preparing ${nextAssetCount} lazy asset descriptors`;
      logPlain(`stage assets: preparing ${nextAssetCount} lazy asset descriptors`);
      queueRender();
    },
    onAssetPrepared: (assetId, prepared, total) => {
      onDashboardAssetPrepared(dashboard, assetId, prepared, total);
      preparedAssets = prepared;
      message = `prepared ${prepared}/${total} asset descriptors`;
      if (!useTui && (prepared === total || prepared % 10 === 0)) {
        logPlain(`stage assets: prepared ${prepared}/${total} (${assetId})`);
      }
      queueRender();
    },
    onBenchmarkStarted: (nextAssetCount, engineIds, nextWorkerCount) => {
      onDashboardBenchmarkStarted(dashboard, nextAssetCount, engineIds, nextWorkerCount);
      stage = 'benchmark';
      assetCount = nextAssetCount;
      workerCount = nextWorkerCount;
      totalJobs = nextAssetCount * engineIds.length;
      message = `running ${totalJobs} engine jobs across ${nextWorkerCount} workers`;
      logPlain(
        `stage benchmark: running ${totalJobs} engine jobs across ${nextWorkerCount} workers`,
      );
      queueRender();
    },
    onScanStarted: ({ engineId, assetId, relativePath, cached, cacheable }) => {
      onDashboardScanStarted(dashboard, { engineId, assetId, relativePath, cached, cacheable });
      const engine = ensureEngine(engineId);
      if (cached) {
        cacheHits += 1;
        if (!useTui) {
          logPlain(`cache hit: ${engineId} ${assetId} ${relativePath}`);
        }
        queueRender();
        return;
      }
      if (cacheable) {
        cacheMisses += 1;
      }
      engine.activeAssetId = assetId;
      engine.activeRelativePath = relativePath;
      if (!useTui) {
        logPlain(`scan start: ${engineId} ${assetId} ${relativePath}${cacheable ? '' : ' live'}`);
      }
      queueRender();
    },
    onImageLoadStarted: ({ engineId, assetId, relativePath }) => {
      onDashboardImageLoadStarted(dashboard, { engineId, assetId, relativePath });
      const engine = ensureEngine(engineId);
      engine.imageLoadingAssetId = assetId;
      if (!useTui) {
        logPlain(`image load: ${engineId} ${assetId} ${relativePath}`);
      }
      queueRender();
    },
    onImageLoadFinished: ({ engineId, assetId, width, height }) => {
      onDashboardImageLoadFinished(dashboard, { engineId, assetId });
      const engine = ensureEngine(engineId);
      if (engine.imageLoadingAssetId === assetId) {
        engine.imageLoadingAssetId = null;
      }
      if (!useTui) {
        logPlain(`image ready: ${engineId} ${assetId} ${width}x${height}`);
      }
      queueRender();
    },
    onScanFinished: ({ engineId, assetId, relativePath, result, wroteToCache }) => {
      onDashboardScanFinished(dashboard, { engineId, assetId, relativePath, result, wroteToCache });
      const engine = ensureEngine(engineId);
      completedJobs += 1;
      engine.completed += 1;
      engine.lastOutcome = result.outcome;
      engine.lastDurationMs = result.durationMs;
      engine.activeAssetId = null;
      engine.activeRelativePath = null;
      engine.imageLoadingAssetId = null;
      if (result.cached) {
        engine.cached += 1;
      } else {
        engine.fresh += 1;
      }
      if (wroteToCache) {
        cacheWrites += 1;
      }
      pushRecent({
        engineId,
        assetId,
        relativePath,
        outcome: result.outcome,
        durationMs: result.durationMs,
        cached: result.cached,
      });
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
      stage = 'done';
      message = 'complete';
      if (useTui) {
        render();
        stderr.write('\u001B[?25h\u001B[?1049l');
      }
      stopped = true;
    },
  };
};
