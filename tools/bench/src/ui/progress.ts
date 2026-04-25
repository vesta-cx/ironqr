import process from 'node:process';
import type { EngineAssetResult } from '../accuracy/types.js';
import { BenchOpenTuiApp } from './app.js';
import {
  createBenchRunModel,
  onBenchRunAssetPrepared,
  onBenchRunAssetsStarted,
  onBenchRunBenchmarkStarted,
  onBenchRunDone,
  onBenchRunImageLoadFinished,
  onBenchRunImageLoadStarted,
  onBenchRunManifestLoaded,
  onBenchRunManifestStarted,
  onBenchRunScanFinished,
  onBenchRunScanStarted,
  onBenchRunStudyTiming,
  onBenchRunStudyUnitsPlanned,
} from './model.js';

const STUDY_TIMING_PREFIX = '__bench_study_timing__';
const DASHBOARD_EVENT_BATCH_BUDGET_MS = 8;
const DASHBOARD_EVENT_BATCH_MAX_ITEMS = 500;

type StudyTimingEvent = {
  readonly id: string;
  readonly durationMs: number;
  readonly group?: 'view' | 'detector';
  readonly outputCount?: number;
  readonly cached?: boolean;
};

export interface BenchProgressReporter {
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
  onStudyUnitsPlanned: (totalUnits: number) => void;
  onScanStarted: (event: {
    readonly engineId: string;
    readonly assetId: string;
    readonly relativePath: string;
    readonly label?: EngineAssetResult['label'];
    readonly cached: boolean;
    readonly cacheable: boolean;
  }) => void;
  onImageLoadStarted: (event: {
    readonly engineId: string;
    readonly assetId: string;
    readonly relativePath: string;
    readonly label?: EngineAssetResult['label'];
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
  onMessage: (message: string) => void;
  requestStop: () => void;
  stop: () => void;
}

export const createBenchProgressReporter = (options: {
  readonly commandName: 'accuracy' | 'performance' | 'study' | 'suite';
  readonly enabled: boolean;
  readonly stderr?: NodeJS.WriteStream;
  readonly requestStop?: () => void;
}): BenchProgressReporter => {
  const stderr = options.stderr ?? process.stderr;
  const enabled = options.enabled && stderr.isTTY;

  let stopped = false;
  const dashboard = createBenchRunModel();
  dashboard.commandName = options.commandName;
  dashboard.message = `${options.commandName} starting`;
  const openTui = enabled
    ? new BenchOpenTuiApp(dashboard, () => {
        dashboard.message = `${options.commandName} stopping after requested interrupt`;
        options.requestStop?.();
      })
    : null;

  const queueRender = (): void => {
    openTui?.update();
  };

  const pendingStudyTimings: StudyTimingEvent[] = [];
  const pendingMessages: string[] = [];
  let dashboardFlushTimer: NodeJS.Timeout | null = null;

  const scheduleDashboardFlush = (): void => {
    if (dashboardFlushTimer !== null) return;
    dashboardFlushTimer = setTimeout(() => flushDashboardEvents(false), 0);
  };

  const flushDashboardEvents = (drain: boolean): void => {
    dashboardFlushTimer = null;
    const startedAt = performance.now();
    let processed = 0;
    while (pendingMessages.length > 0) {
      const message = pendingMessages.shift();
      if (message === undefined) break;
      dashboard.message = `${options.commandName}: ${message}`;
      pushStudyEvent(dashboard, message);
      processed += 1;
      if (!drain && shouldPauseDashboardFlush(startedAt, processed)) break;
    }
    while (pendingMessages.length === 0 && pendingStudyTimings.length > 0) {
      const studyTiming = pendingStudyTimings.shift();
      if (studyTiming === undefined) break;
      onBenchRunStudyTiming(dashboard, studyTiming);
      if (!studyTiming.cached) {
        pushStudyEvent(dashboard, formatStudyTimingEvent(studyTiming));
      }
      processed += 1;
      if (!drain && shouldPauseDashboardFlush(startedAt, processed)) break;
    }
    if (processed > 0) queueRender();
    if (!drain && (pendingMessages.length > 0 || pendingStudyTimings.length > 0)) {
      scheduleDashboardFlush();
    }
  };

  openTui?.start();

  return {
    onManifestStarted: () => {
      onBenchRunManifestStarted(dashboard);
      dashboard.message = `${options.commandName}: ${dashboard.message}`;
      queueRender();
    },
    onManifestLoaded: (nextAssetCount, engineIds, nextCacheEnabled, totals) => {
      onBenchRunManifestLoaded(dashboard, nextAssetCount, engineIds, nextCacheEnabled, totals);
      queueRender();
    },
    onAssetsStarted: (nextAssetCount) => {
      onBenchRunAssetsStarted(dashboard, nextAssetCount);
      queueRender();
    },
    onAssetPrepared: (assetId, prepared, total) => {
      onBenchRunAssetPrepared(dashboard, assetId, prepared, total);
      queueRender();
    },
    onBenchmarkStarted: (nextAssetCount, engineIds, nextWorkerCount) => {
      onBenchRunBenchmarkStarted(dashboard, nextAssetCount, engineIds, nextWorkerCount);
      queueRender();
    },
    onStudyUnitsPlanned: (totalUnits) => {
      onBenchRunStudyUnitsPlanned(dashboard, totalUnits);
      queueRender();
    },
    onScanStarted: ({ engineId, assetId, relativePath, label, cached, cacheable }) => {
      onBenchRunScanStarted(dashboard, {
        engineId,
        assetId,
        relativePath,
        ...(label === undefined ? {} : { label }),
        cached,
        cacheable,
      });
      queueRender();
    },
    onImageLoadStarted: ({ engineId, assetId, relativePath, label }) => {
      onBenchRunImageLoadStarted(dashboard, {
        engineId,
        assetId,
        relativePath,
        ...(label === undefined ? {} : { label }),
      });
      queueRender();
    },
    onImageLoadFinished: ({ engineId, assetId }) => {
      onBenchRunImageLoadFinished(dashboard, { engineId, assetId });
      queueRender();
    },
    onScanFinished: ({ engineId, assetId, relativePath, result, wroteToCache }) => {
      onBenchRunScanFinished(dashboard, {
        engineId,
        assetId,
        relativePath,
        result,
        wroteToCache,
      });
      queueRender();
    },
    onMessage: (message) => {
      const studyTiming = parseStudyTimingMessage(message);
      if (studyTiming) {
        pendingStudyTimings.push(studyTiming);
      } else {
        pendingMessages.push(message);
      }
      scheduleDashboardFlush();
    },
    requestStop: () => {
      dashboard.message = `${options.commandName} stopping after requested interrupt`;
      options.requestStop?.();
      queueRender();
    },
    stop: () => {
      if (stopped) return;
      if (dashboardFlushTimer !== null) {
        clearTimeout(dashboardFlushTimer);
        dashboardFlushTimer = null;
      }
      flushDashboardEvents(true);
      onBenchRunDone(dashboard);
      openTui?.stop();
      stopped = true;
    },
  };
};

const shouldPauseDashboardFlush = (startedAt: number, processed: number): boolean =>
  processed >= DASHBOARD_EVENT_BATCH_MAX_ITEMS ||
  performance.now() - startedAt >= DASHBOARD_EVENT_BATCH_BUDGET_MS;

const pushStudyEvent = (dashboard: { readonly studyEvents: string[] }, message: string): void => {
  dashboard.studyEvents.push(message);
  if (dashboard.studyEvents.length > 500) {
    dashboard.studyEvents.splice(0, dashboard.studyEvents.length - 500);
  }
};

const formatStudyTimingEvent = (event: StudyTimingEvent): string => {
  const group = event.group ?? 'study';
  const output = event.outputCount === undefined ? '' : ` outputs=${event.outputCount}`;
  return `${group} ${event.id} ${formatStudyTimingDuration(event.durationMs)}${output}`;
};

const formatStudyTimingDuration = (durationMs: number): string => {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '-';
  if (durationMs < 1_000) return `${Math.round(durationMs * 10) / 10}ms`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 100) / 10}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
};

const parseStudyTimingMessage = (message: string): StudyTimingEvent | null => {
  if (!message.startsWith(STUDY_TIMING_PREFIX)) return null;
  try {
    const payload = JSON.parse(message.slice(STUDY_TIMING_PREFIX.length)) as Record<
      string,
      unknown
    >;
    if (typeof payload.id !== 'string' || typeof payload.durationMs !== 'number') return null;
    const group =
      payload.group === 'detector' || payload.group === 'view' ? payload.group : undefined;
    const outputCount = typeof payload.outputCount === 'number' ? payload.outputCount : undefined;
    const cached = typeof payload.cached === 'boolean' ? payload.cached : undefined;
    return {
      id: payload.id,
      durationMs: payload.durationMs,
      ...(group === undefined ? {} : { group }),
      ...(outputCount === undefined ? {} : { outputCount }),
      ...(cached === undefined ? {} : { cached }),
    };
  } catch {
    return null;
  }
};
