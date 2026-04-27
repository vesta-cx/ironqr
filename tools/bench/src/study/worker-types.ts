import type { BenchCorpusAsset } from '../core/corpus.js';
import type { ScannerArtifactCacheSummary } from './scanner-artifact-cache.js';

export interface StudyWorkerAsset
  extends Pick<
    BenchCorpusAsset,
    'id' | 'assetId' | 'label' | 'sha256' | 'imagePath' | 'relativePath' | 'expectedTexts'
  > {}

export interface StudyCacheWrite {
  readonly assetId: string;
  readonly cacheKey: string;
  readonly result: unknown;
}

export interface StudyWorkerRequest {
  readonly type: 'run';
  readonly jobId: string;
  readonly repoRoot: string;
  readonly pluginId: string;
  readonly config: Record<string, unknown>;
  readonly asset: StudyWorkerAsset;
  readonly cacheFile: string;
  readonly artifactCacheDirectory: string;
  readonly cacheEnabled: boolean;
  readonly refreshCache: boolean;
  readonly floodSemaphore?: SharedArrayBuffer;
  readonly floodConcurrencyLimit?: number;
}

export type StudyWorkerResponse =
  | {
      readonly type: 'ready';
    }
  | {
      readonly type: 'log';
      readonly jobId: string;
      readonly message: string;
    }
  | {
      readonly type: 'result';
      readonly jobId: string;
      readonly result: unknown;
      readonly cacheWrites: readonly StudyCacheWrite[];
      readonly artifactCache: ScannerArtifactCacheSummary;
    }
  | {
      readonly type: 'error';
      readonly jobId: string;
      readonly message: string;
      readonly stack?: string;
    };
