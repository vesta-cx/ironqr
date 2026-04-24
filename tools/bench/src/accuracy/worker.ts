import { readBenchImage } from '../shared/image.js';
import { getAccuracyEngineById } from './engines.js';
import type { AccuracyScanResult, CorpusBenchAsset } from './types.js';
import type {
  AccuracyWorkerImageLoadFinishedMessage,
  AccuracyWorkerImageLoadStartedMessage,
  AccuracyWorkerJobStartedMessage,
  AccuracyWorkerRequest,
  AccuracyWorkerResponse,
  AccuracyWorkerResultMessage,
} from './worker-types.js';

const roundDurationMs = (value: number): number => Math.round(value * 100) / 100;

const asMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const failureScan = (error: unknown): AccuracyScanResult => ({
  attempted: true,
  succeeded: false,
  results: [],
  failureReason: 'engine_error',
  error: asMessage(error),
});

const postWorkerMessage = (message: AccuracyWorkerResponse): void => {
  postMessage(message);
};

const toBenchAsset = (message: AccuracyWorkerRequest): CorpusBenchAsset => {
  return {
    id: message.asset.id,
    label: message.asset.label,
    sha256: message.asset.sha256,
    imagePath: message.asset.imagePath,
    relativePath: message.asset.relativePath,
    expectedTexts: message.asset.expectedTexts,
    loadImage: async () => {
      const started: AccuracyWorkerImageLoadStartedMessage = {
        type: 'image-load-started',
        jobId: message.jobId,
        engineId: message.engineId,
        assetId: message.asset.id,
        relativePath: message.asset.relativePath,
        label: message.asset.label,
      };
      postWorkerMessage(started);
      const image = await readBenchImage(message.asset.imagePath);
      const finished: AccuracyWorkerImageLoadFinishedMessage = {
        type: 'image-load-finished',
        jobId: message.jobId,
        engineId: message.engineId,
        assetId: message.asset.id,
        width: image.width,
        height: image.height,
      };
      postWorkerMessage(finished);
      return image;
    },
  };
};

addEventListener('message', async (event: MessageEvent<AccuracyWorkerRequest>) => {
  const message = event.data;
  if (!message || message.type !== 'run') {
    return;
  }

  const started: AccuracyWorkerJobStartedMessage = {
    type: 'job-started',
    jobId: message.jobId,
    engineId: message.engineId,
    assetId: message.asset.id,
    relativePath: message.asset.relativePath,
    label: message.asset.label,
  };
  postWorkerMessage(started);

  const startedAt = performance.now();
  const scan = await (async (): Promise<AccuracyScanResult> => {
    try {
      const engine = getAccuracyEngineById(message.engineId);
      return await engine.scan(toBenchAsset(message), message.runOptions);
    } catch (error) {
      return failureScan(error);
    }
  })();

  const result: AccuracyWorkerResultMessage = {
    type: 'result',
    jobId: message.jobId,
    engineId: message.engineId,
    assetId: message.asset.id,
    scan,
    durationMs: roundDurationMs(performance.now() - startedAt),
  };
  postWorkerMessage(result);
});
