import type { AccuracyProgressReporter } from './progress.js';
import type { AccuracyEngineRunOptions, AccuracyScanResult } from './types.js';
import type {
  AccuracyWorkerAsset,
  AccuracyWorkerRequest,
  AccuracyWorkerResponse,
} from './worker-types.js';

interface AccuracyWorkerJob {
  readonly engineId: string;
  readonly cacheable: boolean;
  readonly asset: AccuracyWorkerAsset;
  readonly runOptions?: AccuracyEngineRunOptions;
}

interface AccuracyWorkerExecution {
  readonly scan: AccuracyScanResult;
  readonly durationMs: number;
  readonly imageLoadDurationMs: number | null;
  readonly totalJobDurationMs: number;
}

interface QueuedJob {
  readonly request: AccuracyWorkerRequest;
  readonly resolve: (value: AccuracyWorkerExecution) => void;
  readonly reject: (reason?: unknown) => void;
}

interface WorkerSlot {
  readonly id: number;
  worker: Worker | null;
  current: QueuedJob | null;
}

const resolveWorkerModuleUrl = (): URL => {
  if (import.meta.url.endsWith('.ts')) {
    return new URL('./worker.ts', import.meta.url);
  }
  return new URL('./accuracy/worker.js', import.meta.url);
};

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

export interface AccuracyWorkerPool {
  run: (job: AccuracyWorkerJob) => Promise<AccuracyWorkerExecution>;
  close: () => Promise<void>;
}

export const createAccuracyWorkerPool = (
  size: number,
  progress: AccuracyProgressReporter,
): AccuracyWorkerPool => {
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new Error(`Worker pool size must be a positive safe integer, got ${size}`);
  }

  let closed = false;
  let nextJobId = 0;
  const queue: QueuedJob[] = [];
  const slots: WorkerSlot[] = [];

  const dispatch = (): void => {
    if (closed) return;
    for (const slot of slots) {
      if (slot.current || queue.length === 0) continue;
      const job = queue.shift();
      if (!job) continue;
      const worker = slot.worker;
      if (!worker) {
        job.reject(new Error(`Accuracy worker slot ${slot.id} is not initialized`));
        continue;
      }
      slot.current = job;
      try {
        worker.postMessage(job.request);
      } catch (error) {
        slot.current = null;
        job.reject(asError(error));
      }
    }
  };

  const spawnWorker = (slotId: number): Worker => {
    const worker = new Worker(resolveWorkerModuleUrl().href, { type: 'module' });

    worker.onmessage = (event: MessageEvent<AccuracyWorkerResponse>) => {
      const slot = slots[slotId];
      if (!slot) return;
      const current = slot.current;
      if (!current) return;
      const message = event.data;
      if (!message || message.jobId !== current.request.jobId) {
        return;
      }

      switch (message.type) {
        case 'job-started':
          progress.onScanStarted({
            engineId: message.engineId,
            assetId: message.assetId,
            relativePath: message.relativePath,
            label: message.label,
            cached: false,
            cacheable: current.request.cacheable,
          });
          return;
        case 'image-load-started':
          progress.onImageLoadStarted({
            engineId: message.engineId,
            assetId: message.assetId,
            relativePath: message.relativePath,
            label: message.label,
          });
          return;
        case 'image-load-finished':
          progress.onImageLoadFinished({
            engineId: message.engineId,
            assetId: message.assetId,
            width: message.width,
            height: message.height,
          });
          return;
        case 'image-load-failed':
          return;
        case 'result':
          slot.current = null;
          current.resolve({
            scan: message.scan,
            durationMs: message.durationMs,
            imageLoadDurationMs: message.imageLoadDurationMs,
            totalJobDurationMs: message.totalJobDurationMs,
          });
          dispatch();
          return;
      }
    };

    worker.onerror = (event) => {
      const slot = slots[slotId];
      if (!slot || closed) return;
      const current = slot.current;
      slot.current = null;
      void slot.worker?.terminate();
      slot.worker = spawnWorker(slotId);
      if (current) {
        current.reject(asError(event.error ?? event.message));
      }
      dispatch();
    };

    worker.onmessageerror = () => {
      const slot = slots[slotId];
      if (!slot || closed) return;
      const current = slot.current;
      slot.current = null;
      void slot.worker?.terminate();
      slot.worker = spawnWorker(slotId);
      if (current) {
        current.reject(new Error('Accuracy worker failed to deserialize a message'));
      }
      dispatch();
    };

    return worker;
  };

  try {
    for (let index = 0; index < size; index += 1) {
      const slot: WorkerSlot = { id: index, worker: null, current: null };
      slots.push(slot);
      slot.worker = spawnWorker(slot.id);
    }
  } catch (error) {
    for (const slot of slots) {
      void slot.worker?.terminate();
    }
    throw error;
  }

  return {
    run: (job) => {
      if (closed) {
        return Promise.reject(new Error('Accuracy worker pool is closed'));
      }

      return new Promise((resolve, reject) => {
        queue.push({
          request: {
            type: 'run',
            jobId: `job-${nextJobId++}`,
            engineId: job.engineId,
            cacheable: job.cacheable,
            asset: job.asset,
            ...(job.runOptions === undefined ? {} : { runOptions: job.runOptions }),
          },
          resolve,
          reject,
        });
        dispatch();
      });
    },
    close: async () => {
      if (closed) return;
      closed = true;
      while (queue.length > 0) {
        const queued = queue.shift();
        queued?.reject(new Error('Accuracy worker pool closed before dispatch'));
      }
      await Promise.all(
        slots.map(async (slot) => {
          slot.current?.reject(new Error('Accuracy worker pool closed during execution'));
          slot.current = null;
          await slot.worker?.terminate();
        }),
      );
    },
  };
};
