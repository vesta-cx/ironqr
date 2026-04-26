import { readBenchImage } from '../shared/image.js';
import { openStudyCache } from './cache.js';
import {
  binaryBitHotPathStudyPlugin,
  binaryPrefilterSignalsStudyPlugin,
  finderRunMapStudyPlugin,
  moduleSamplingHotPathStudyPlugin,
  scalarMaterializationFusionStudyPlugin,
  sharedBinaryDetectorArtifactsStudyPlugin,
  thresholdStatsCacheStudyPlugin,
  warmImageProcessingStudyWorker,
} from './image-processing.js';
import { proposalDetectorPolicyStudyPlugin } from './proposal-detector-policy.js';
import { proposalDetectorPolicyDecodeConfirmationStudyPlugin } from './proposal-detector-policy-decode-confirmation.js';
import { proposalGenerationVariantsStudyPlugin } from './proposal-generation-variants.js';
import { proposalGeometryDecodeConfirmationStudyPlugin } from './proposal-geometry-decode-confirmation.js';
import { proposalGeometryViabilityStudyPlugin } from './proposal-geometry-viability.js';
import { proposalRankingDecodeConfirmationStudyPlugin } from './proposal-ranking-decode-confirmation.js';
import type { StudyCacheHandle } from './types.js';
import type { StudyCacheWrite, StudyWorkerRequest, StudyWorkerResponse } from './worker-types.js';

const plugins = new Map(
  [
    binaryBitHotPathStudyPlugin,
    binaryPrefilterSignalsStudyPlugin,
    finderRunMapStudyPlugin,
    moduleSamplingHotPathStudyPlugin,
    scalarMaterializationFusionStudyPlugin,
    sharedBinaryDetectorArtifactsStudyPlugin,
    thresholdStatsCacheStudyPlugin,
    proposalDetectorPolicyStudyPlugin,
    proposalDetectorPolicyDecodeConfirmationStudyPlugin,
    proposalGenerationVariantsStudyPlugin,
    proposalGeometryViabilityStudyPlugin,
    proposalGeometryDecodeConfirmationStudyPlugin,
    proposalRankingDecodeConfirmationStudyPlugin,
  ].map((plugin) => [plugin.id, plugin] as const),
);

self.onmessage = (event: MessageEvent<StudyWorkerRequest>): void => {
  void run(event.data);
};

const post = (message: StudyWorkerResponse): void => {
  self.postMessage(message);
};

Reflect.set(globalThis, '__BENCH_STUDY_WORKER__', true);

void warmImageProcessingStudyWorker().then(
  () => post({ type: 'ready' }),
  (error) =>
    post({
      type: 'error',
      jobId: 'worker-startup',
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    }),
);

const run = async (request: StudyWorkerRequest): Promise<void> => {
  try {
    const plugin = plugins.get(request.pluginId);
    if (!plugin?.runAsset) throw new Error(`Study worker cannot run plugin: ${request.pluginId}`);
    const baseCache = await openStudyCache<unknown>({
      enabled: request.cacheEnabled,
      refresh: request.refreshCache,
      file: request.cacheFile,
    });
    const cacheWrites: StudyCacheWrite[] = [];
    const asset = {
      ...request.asset,
      loadImage: () => readBenchImage(request.asset.imagePath),
    };
    const cache = workerCache(baseCache, request.asset.id, cacheWrites);
    const previousSemaphore = Reflect.get(globalThis, '__BENCH_STUDY_FLOOD_SEMAPHORE__');
    const previousFloodLimit = Reflect.get(globalThis, '__BENCH_STUDY_FLOOD_CONCURRENCY_LIMIT__');
    if (request.floodSemaphore) {
      Reflect.set(globalThis, '__BENCH_STUDY_FLOOD_SEMAPHORE__', request.floodSemaphore);
      Reflect.set(
        globalThis,
        '__BENCH_STUDY_FLOOD_CONCURRENCY_LIMIT__',
        request.floodConcurrencyLimit ?? 1,
      );
    }
    const previousWorkerFlag = Reflect.get(globalThis, '__BENCH_STUDY_WORKER__');
    Reflect.set(globalThis, '__BENCH_STUDY_WORKER__', true);
    try {
      const result = await plugin.runAsset({
        repoRoot: request.repoRoot,
        asset,
        config: request.config as never,
        reports: { accuracy: async () => null, performance: async () => null },
        cache,
        log: (message) => post({ type: 'log', jobId: request.jobId, message }),
      });
      post({ type: 'result', jobId: request.jobId, result, cacheWrites });
    } finally {
      restoreGlobal('__BENCH_STUDY_WORKER__', previousWorkerFlag);
      restoreGlobal('__BENCH_STUDY_FLOOD_SEMAPHORE__', previousSemaphore);
      restoreGlobal('__BENCH_STUDY_FLOOD_CONCURRENCY_LIMIT__', previousFloodLimit);
    }
  } catch (error) {
    post({
      type: 'error',
      jobId: request.jobId,
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    });
  }
};

const restoreGlobal = (key: string, value: unknown): void => {
  if (value === undefined) {
    Reflect.deleteProperty(globalThis, key);
    return;
  }
  Reflect.set(globalThis, key, value);
};

const workerCache = (
  baseCache: StudyCacheHandle<unknown>,
  assetId: string,
  cacheWrites: StudyCacheWrite[],
): StudyCacheHandle<unknown> => {
  const overlay = new Map<string, unknown>();
  return {
    has(asset, cacheKey) {
      if (overlay.has(cacheKey)) return true;
      return baseCache.has(asset, cacheKey);
    },
    async read(asset, cacheKey) {
      if (overlay.has(cacheKey)) return overlay.get(cacheKey) ?? null;
      return baseCache.read(asset, cacheKey);
    },
    async write(_asset, cacheKey, result) {
      overlay.set(cacheKey, result);
      cacheWrites.push({ assetId, cacheKey, result });
    },
    async remove(_asset, cacheKey) {
      const deleted = overlay.delete(cacheKey);
      return deleted || baseCache.remove(_asset, cacheKey);
    },
    async purge() {
      return 0;
    },
    async flush() {},
    summary: baseCache.summary,
  };
};
