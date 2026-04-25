import type { BenchCorpusAsset } from '../core/corpus.js';
import type { StudyCacheHandle, StudyPlugin } from './types.js';
import type { StudyCacheWrite, StudyWorkerRequest, StudyWorkerResponse } from './worker-types.js';

interface StudyWorkerJob {
  readonly repoRoot: string;
  readonly plugin: StudyPlugin;
  readonly config: Record<string, unknown>;
  readonly asset: BenchCorpusAsset;
  readonly cacheFile: string;
  readonly cacheEnabled: boolean;
  readonly refreshCache: boolean;
}

interface StudyWorkerExecution {
  readonly result: unknown;
  readonly cacheWrites: readonly StudyCacheWrite[];
}

interface QueuedJob {
  readonly request: StudyWorkerRequest;
  readonly resolve: (value: StudyWorkerExecution) => void;
  readonly reject: (reason?: unknown) => void;
}

interface WorkerSlot {
  readonly id: number;
  worker: Worker | null;
  current: QueuedJob | null;
  ready: boolean;
}

export interface StudyWorkerPool {
  readonly ready: () => Promise<void>;
  readonly run: (job: StudyWorkerJob) => Promise<StudyWorkerExecution>;
  readonly close: () => Promise<void>;
}

const resolveWorkerModuleUrl = (): URL =>
  import.meta.url.endsWith('.ts')
    ? new URL('./worker.ts', import.meta.url)
    : new URL('./study/worker.js', import.meta.url);

export const createStudyWorkerPool = (
  size: number,
  options: {
    readonly log: (message: string) => void;
    readonly cache: StudyCacheHandle<unknown>;
  },
): StudyWorkerPool => {
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new Error(`Study worker pool size must be a positive safe integer, got ${size}`);
  }

  let closed = false;
  let nextJobId = 0;
  const floodConcurrencyLimit = Math.max(1, Math.floor(size * 0.5));
  const floodSemaphore = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  Atomics.store(new Int32Array(floodSemaphore), 0, floodConcurrencyLimit);
  const queue: QueuedJob[] = [];
  const slots: WorkerSlot[] = [];
  const readyPromises: Promise<void>[] = [];
  const readyResolvers: Array<() => void> = [];

  const dispatch = (): void => {
    if (closed) return;
    for (const slot of slots) {
      if (!slot.ready || slot.current || queue.length === 0) continue;
      const job = queue.shift();
      if (!job) continue;
      const worker = slot.worker;
      if (!worker) {
        job.reject(new Error(`Study worker slot ${slot.id} is not initialized`));
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
    worker.onmessage = (event: MessageEvent<StudyWorkerResponse>) => {
      const slot = slots[slotId];
      if (!slot) return;
      const message = event.data;
      if (message.type === 'ready') {
        slot.ready = true;
        readyResolvers[slotId]?.();
        dispatch();
        return;
      }
      if (!slot.current) return;
      const current = slot.current;
      if (message.jobId !== current.request.jobId) return;
      if (message.type === 'log') {
        options.log(message.message);
        return;
      }
      slot.current = null;
      if (message.type === 'error') {
        current.reject(
          new Error(message.stack ? `${message.message}\n${message.stack}` : message.message),
        );
      } else {
        current.resolve({ result: message.result, cacheWrites: message.cacheWrites });
      }
      dispatch();
    };
    worker.onerror = (event) => {
      const slot = slots[slotId];
      if (!slot || closed) return;
      const current = slot.current;
      slot.current = null;
      void slot.worker?.terminate();
      slot.ready = false;
      slot.worker = spawnWorker(slotId);
      current?.reject(asError(event.error ?? event.message));
      dispatch();
    };
    return worker;
  };

  for (let index = 0; index < size; index += 1) {
    const slot: WorkerSlot = { id: index, worker: null, current: null, ready: false };
    slots.push(slot);
    readyPromises.push(new Promise<void>((resolve) => readyResolvers.push(resolve)));
    slot.worker = spawnWorker(slot.id);
  }

  return {
    async ready() {
      await Promise.all(readyPromises);
    },
    run(job) {
      if (closed) return Promise.reject(new Error('Study worker pool is closed'));
      return new Promise((resolve, reject) => {
        queue.push({
          request: {
            type: 'run',
            jobId: `study-job-${nextJobId++}`,
            repoRoot: job.repoRoot,
            pluginId: job.plugin.id,
            config: job.config,
            asset: {
              id: job.asset.id,
              assetId: job.asset.assetId,
              label: job.asset.label,
              sha256: job.asset.sha256,
              imagePath: job.asset.imagePath,
              relativePath: job.asset.relativePath,
              expectedTexts: job.asset.expectedTexts,
            },
            cacheFile: job.cacheFile,
            cacheEnabled: job.cacheEnabled,
            refreshCache: job.refreshCache,
            floodSemaphore,
            floodConcurrencyLimit,
          },
          resolve,
          reject,
        });
        dispatch();
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const resolveReady of readyResolvers) resolveReady();
      while (queue.length > 0)
        queue.shift()?.reject(new Error('Study worker pool closed before dispatch'));
      await Promise.all(
        slots.map(async (slot) => {
          slot.current?.reject(new Error('Study worker pool closed during execution'));
          slot.current = null;
          await slot.worker?.terminate();
        }),
      );
    },
  };
};

export const applyStudyCacheWrites = async (
  cache: StudyCacheHandle<unknown>,
  assets: ReadonlyMap<string, BenchCorpusAsset>,
  writes: readonly StudyCacheWrite[],
): Promise<void> => {
  for (const write of writes) {
    const asset = assets.get(write.assetId);
    if (!asset) continue;
    await cache.write(asset, write.cacheKey, write.result);
  }
};

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));
