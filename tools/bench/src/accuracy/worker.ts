import { asMessage } from '../shared/errors.js';
import { readBenchImage } from '../shared/image.js';
import { getAccuracyEngineById } from './engines.js';
import type { AccuracyScanResult, CorpusBenchAsset } from './types.js';
import type {
  AccuracyWorkerImageLoadFailedMessage,
  AccuracyWorkerImageLoadFinishedMessage,
  AccuracyWorkerImageLoadStartedMessage,
  AccuracyWorkerJobStartedMessage,
  AccuracyWorkerRequest,
  AccuracyWorkerResultMessage,
  AccuracyWorkerRunMessage,
} from './worker-types.js';

const roundDurationMs = (value: number): number => Math.round(value * 100) / 100;

const failureScan = (error: unknown): AccuracyScanResult => ({
  status: 'error',
  attempted: true,
  succeeded: false,
  results: [],
  failureReason: 'engine_error',
  error: asMessage(error),
});

const toBenchAsset = (
  message: AccuracyWorkerRunMessage,
  onImageLoadDuration: (durationMs: number) => void,
): CorpusBenchAsset => {
  return {
    id: message.asset.id,
    assetId: message.asset.id,
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
      postMessage(started);
      try {
        const loadStartedAt = performance.now();
        const image = await readBenchImage(message.asset.imagePath);
        onImageLoadDuration(roundDurationMs(performance.now() - loadStartedAt));
        const finished: AccuracyWorkerImageLoadFinishedMessage = {
          type: 'image-load-finished',
          jobId: message.jobId,
          engineId: message.engineId,
          assetId: message.asset.id,
          width: image.width,
          height: image.height,
        };
        postMessage(finished);
        return image;
      } catch (error) {
        const failed: AccuracyWorkerImageLoadFailedMessage = {
          type: 'image-load-failed',
          jobId: message.jobId,
          engineId: message.engineId,
          assetId: message.asset.id,
          error: asMessage(error),
        };
        postMessage(failed);
        throw error;
      }
    },
  };
};

addEventListener('message', async (event: MessageEvent<AccuracyWorkerRequest>) => {
  const message = event.data;
  if (!isRunMessage(message)) {
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
  postMessage(started);

  const startedAt = performance.now();
  let imageLoadDurationMs: number | null = null;
  const scan = await (async (): Promise<AccuracyScanResult> => {
    try {
      const engine = getAccuracyEngineById(message.engineId);
      return await engine.scan(
        toBenchAsset(message, (durationMs) => {
          imageLoadDurationMs = durationMs;
        }),
        message.runOptions,
      );
    } catch (error) {
      return failureScan(error);
    }
  })();

  const totalJobDurationMs = roundDurationMs(performance.now() - startedAt);
  const result: AccuracyWorkerResultMessage = {
    type: 'result',
    jobId: message.jobId,
    engineId: message.engineId,
    assetId: message.asset.id,
    scan,
    durationMs: roundDurationMs(totalJobDurationMs - (imageLoadDurationMs ?? 0)),
    imageLoadDurationMs,
    totalJobDurationMs,
  };
  postMessage(result);
});

const isRunMessage = (value: AccuracyWorkerRequest): value is AccuracyWorkerRunMessage => {
  if (!value || typeof value !== 'object' || value.type !== 'run') return false;
  return (
    typeof value.jobId === 'string' &&
    typeof value.engineId === 'string' &&
    typeof value.cacheable === 'boolean' &&
    !!value.asset &&
    typeof value.asset === 'object' &&
    typeof value.asset.id === 'string' &&
    (value.asset.label === 'qr-pos' || value.asset.label === 'qr-neg') &&
    typeof value.asset.sha256 === 'string' &&
    typeof value.asset.imagePath === 'string' &&
    typeof value.asset.relativePath === 'string' &&
    Array.isArray(value.asset.expectedTexts)
  );
};
