import type { AccuracyEngineRunOptions, AccuracyScanResult, CorpusBenchAsset } from './types.js';

export interface AccuracyWorkerAsset {
  readonly id: string;
  readonly label: CorpusBenchAsset['label'];
  readonly sha256: string;
  readonly imagePath: string;
  readonly relativePath: string;
  readonly expectedTexts: readonly string[];
}

export interface AccuracyWorkerRunMessage {
  readonly type: 'run';
  readonly jobId: string;
  readonly engineId: string;
  readonly cacheable: boolean;
  readonly asset: AccuracyWorkerAsset;
  readonly runOptions?: AccuracyEngineRunOptions;
}

export interface AccuracyWorkerJobStartedMessage {
  readonly type: 'job-started';
  readonly jobId: string;
  readonly engineId: string;
  readonly assetId: string;
  readonly relativePath: string;
  readonly label: AccuracyWorkerAsset['label'];
}

export interface AccuracyWorkerImageLoadStartedMessage {
  readonly type: 'image-load-started';
  readonly jobId: string;
  readonly engineId: string;
  readonly assetId: string;
  readonly relativePath: string;
  readonly label: AccuracyWorkerAsset['label'];
}

export interface AccuracyWorkerImageLoadFinishedMessage {
  readonly type: 'image-load-finished';
  readonly jobId: string;
  readonly engineId: string;
  readonly assetId: string;
  readonly width: number;
  readonly height: number;
}

export interface AccuracyWorkerResultMessage {
  readonly type: 'result';
  readonly jobId: string;
  readonly engineId: string;
  readonly assetId: string;
  readonly scan: AccuracyScanResult;
  readonly durationMs: number;
}

export type AccuracyWorkerRequest = AccuracyWorkerRunMessage;

export type AccuracyWorkerResponse =
  | AccuracyWorkerJobStartedMessage
  | AccuracyWorkerImageLoadStartedMessage
  | AccuracyWorkerImageLoadFinishedMessage
  | AccuracyWorkerResultMessage;
