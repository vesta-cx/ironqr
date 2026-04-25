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
} from './image-processing.js';
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
  ].map((plugin) => [plugin.id, plugin] as const),
);

self.onmessage = (event: MessageEvent<StudyWorkerRequest>): void => {
  void run(event.data);
};

const post = (message: StudyWorkerResponse): void => {
  self.postMessage(message);
};

Reflect.set(globalThis, '__BENCH_STUDY_WORKER__', true);

post({ type: 'ready' });

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
    const result = await plugin.runAsset({
      repoRoot: request.repoRoot,
      asset,
      config: request.config as never,
      reports: { accuracy: async () => null, performance: async () => null },
      cache,
      log: (message) => post({ type: 'log', jobId: request.jobId, message }),
    });
    post({ type: 'result', jobId: request.jobId, result, cacheWrites });
  } catch (error) {
    post({
      type: 'error',
      jobId: request.jobId,
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    });
  }
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
