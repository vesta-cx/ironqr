import type { AccuracyEngineRunOptions, AccuracyScanResult, CorpusBenchAsset } from './types.js';

/** Asset payload copied into an accuracy worker process. */
export interface AccuracyWorkerAsset {
  readonly id: string;
  readonly label: CorpusBenchAsset['label'];
  readonly sha256: string;
  readonly imagePath: string;
  readonly relativePath: string;
  readonly expectedTexts: readonly string[];
}

/** Request sent from the main benchmark process to an accuracy worker. */
export interface AccuracyWorkerRunMessage {
  readonly type: 'run';
  readonly jobId: string;
  readonly engineId: string;
  readonly cacheable: boolean;
  readonly asset: AccuracyWorkerAsset;
  readonly runOptions?: AccuracyEngineRunOptions;
}

/** Worker notification that a scan job has started. */
export interface AccuracyWorkerJobStartedMessage {
  readonly type: 'job-started';
  readonly jobId: string;
  readonly engineId: string;
  readonly assetId: string;
  readonly relativePath: string;
  readonly label: AccuracyWorkerAsset['label'];
}

/** Worker notification that image decoding has started for a scan job. */
export interface AccuracyWorkerImageLoadStartedMessage {
  readonly type: 'image-load-started';
  readonly jobId: string;
  readonly engineId: string;
  readonly assetId: string;
  readonly relativePath: string;
  readonly label: AccuracyWorkerAsset['label'];
}

/** Worker notification that image decoding finished successfully. */
export interface AccuracyWorkerImageLoadFinishedMessage {
  readonly type: 'image-load-finished';
  readonly jobId: string;
  readonly engineId: string;
  readonly assetId: string;
  readonly width: number;
  readonly height: number;
}

/** Worker notification that image decoding failed before engine execution. */
export interface AccuracyWorkerImageLoadFailedMessage {
  readonly type: 'image-load-failed';
  readonly jobId: string;
  readonly engineId: string;
  readonly assetId: string;
  readonly error: string;
}

/** Final worker response for a scan job; durations are wall-clock milliseconds. */
export interface AccuracyWorkerResultMessage {
  readonly type: 'result';
  readonly jobId: string;
  readonly engineId: string;
  readonly assetId: string;
  readonly scan: AccuracyScanResult;
  /** Engine call duration excluding image load time when the adapter uses asset.loadImage(). */
  readonly durationMs: number;
  readonly imageLoadDurationMs: number | null;
  readonly totalJobDurationMs: number;
}

export type AccuracyWorkerRequest = AccuracyWorkerRunMessage;

export type AccuracyWorkerResponse =
  | AccuracyWorkerJobStartedMessage
  | AccuracyWorkerImageLoadStartedMessage
  | AccuracyWorkerImageLoadFinishedMessage
  | AccuracyWorkerImageLoadFailedMessage
  | AccuracyWorkerResultMessage;
