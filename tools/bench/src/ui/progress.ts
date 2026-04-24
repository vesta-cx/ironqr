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
} from './model.js';

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
      dashboard.message = `${options.commandName}: ${message}`;
      queueRender();
    },
    requestStop: () => {
      dashboard.message = `${options.commandName} stopping after requested interrupt`;
      options.requestStop?.();
      queueRender();
    },
    stop: () => {
      if (stopped) return;
      onBenchRunDone(dashboard);
      openTui?.stop();
      stopped = true;
    },
  };
};
