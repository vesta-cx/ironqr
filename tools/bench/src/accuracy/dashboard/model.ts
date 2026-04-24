import type { EngineAssetResult } from '../types.js';

export type DashboardStage = 'manifest' | 'assets' | 'benchmark' | 'done';

export type TimingBucketKey = 'positive-pass' | 'positive-fail' | 'negative-pass' | 'negative-fail';

export interface TimingBucketStats {
  readonly count: number;
  readonly totalMs: number;
  readonly maxMs: number;
}

export type TimingBuckets = Record<TimingBucketKey, TimingBucketStats>;

export interface DashboardEngineStats {
  readonly id: string;
  completed: number;
  cacheHits: number;
  cacheMisses: number;
  cacheWrites: number;
  fresh: number;
  qrPass: number;
  qrPartial: number;
  qrNoDecode: number;
  qrMismatch: number;
  qrErrors: number;
  negativePass: number;
  falsePositive: number;
  negativeErrors: number;
  lastOutcome: EngineAssetResult['outcome'] | null;
  lastDurationMs: number | null;
  readonly timing: TimingBuckets;
}

export interface ActiveScan {
  readonly engineId: string;
  readonly assetId: string;
  readonly relativePath: string;
  readonly label?: EngineAssetResult['label'];
  readonly cached: boolean;
  readonly cacheable: boolean;
  phase: 'queued' | 'loading-image' | 'scanning';
  readonly startedAtMs: number;
  updatedAtMs: number;
}

export interface RecentScan {
  readonly finishedAtMs: number;
  readonly engineId: string;
  readonly assetId: string;
  readonly relativePath: string;
  readonly result: EngineAssetResult;
}

export interface SlowScan {
  readonly engineId: string;
  readonly assetId: string;
  readonly relativePath: string;
  readonly label: EngineAssetResult['label'];
  readonly outcome: EngineAssetResult['outcome'];
  readonly durationMs: number;
}

export interface BenchDashboardModel {
  stage: DashboardStage;
  message: string;
  assetCount: number;
  positiveAssetCount: number;
  negativeAssetCount: number;
  preparedAssets: number;
  totalJobs: number;
  completedJobs: number;
  workerCount: number;
  cacheEnabled: boolean;
  readonly engineOrder: string[];
  readonly engines: Map<string, DashboardEngineStats>;
  readonly activeScans: Map<string, ActiveScan>;
  readonly recentScans: RecentScan[];
  readonly slowestFreshScans: SlowScan[];
}

export const MAX_SLOWEST_FRESH_SCANS = 8;
export const MAX_RECENT_SCANS = 100;

const TIMING_BUCKETS: readonly TimingBucketKey[] = [
  'positive-pass',
  'positive-fail',
  'negative-pass',
  'negative-fail',
];

const emptyTimingBucket = (): TimingBucketStats => ({ count: 0, totalMs: 0, maxMs: 0 });

const createTimingBuckets = (): TimingBuckets => ({
  'positive-pass': emptyTimingBucket(),
  'positive-fail': emptyTimingBucket(),
  'negative-pass': emptyTimingBucket(),
  'negative-fail': emptyTimingBucket(),
});

export const createBenchDashboardModel = (): BenchDashboardModel => ({
  stage: 'manifest',
  message: 'starting',
  assetCount: 0,
  positiveAssetCount: 0,
  negativeAssetCount: 0,
  preparedAssets: 0,
  totalJobs: 0,
  completedJobs: 0,
  workerCount: 0,
  cacheEnabled: false,
  engineOrder: [],
  engines: new Map(),
  activeScans: new Map(),
  recentScans: [],
  slowestFreshScans: [],
});

export const ensureDashboardEngine = (
  model: BenchDashboardModel,
  engineId: string,
): DashboardEngineStats => {
  const existing = model.engines.get(engineId);
  if (existing) return existing;

  const created: DashboardEngineStats = {
    id: engineId,
    completed: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheWrites: 0,
    fresh: 0,
    qrPass: 0,
    qrPartial: 0,
    qrNoDecode: 0,
    qrMismatch: 0,
    qrErrors: 0,
    negativePass: 0,
    falsePositive: 0,
    negativeErrors: 0,
    lastOutcome: null,
    lastDurationMs: null,
    timing: createTimingBuckets(),
  };
  model.engines.set(engineId, created);
  model.engineOrder.push(engineId);
  return created;
};

export const onDashboardManifestStarted = (model: BenchDashboardModel): void => {
  model.stage = 'manifest';
  model.message = 'reading approved corpus manifest';
};

export const onDashboardManifestLoaded = (
  model: BenchDashboardModel,
  assetCount: number,
  engineIds: readonly string[],
  cacheEnabled: boolean,
  totals: { readonly positiveCount: number; readonly negativeCount: number } = {
    positiveCount: 0,
    negativeCount: 0,
  },
): void => {
  model.assetCount = assetCount;
  model.positiveAssetCount = totals.positiveCount;
  model.negativeAssetCount = totals.negativeCount;
  model.totalJobs = assetCount * engineIds.length;
  model.cacheEnabled = cacheEnabled;
  model.message = `loaded ${assetCount} approved assets and ${engineIds.length} engines`;
  for (const engineId of engineIds) ensureDashboardEngine(model, engineId);
};

export const onDashboardAssetsStarted = (model: BenchDashboardModel, assetCount: number): void => {
  model.stage = 'assets';
  model.assetCount = assetCount;
  model.message = `preparing ${assetCount} lazy asset descriptors`;
};

export const onDashboardAssetPrepared = (
  model: BenchDashboardModel,
  assetId: string,
  prepared: number,
  total: number,
): void => {
  model.preparedAssets = prepared;
  model.message = `prepared ${prepared}/${total} asset descriptors (${assetId})`;
};

export const onDashboardBenchmarkStarted = (
  model: BenchDashboardModel,
  assetCount: number,
  engineIds: readonly string[],
  workerCount: number,
): void => {
  model.stage = 'benchmark';
  model.assetCount = assetCount;
  model.workerCount = workerCount;
  model.totalJobs = assetCount * engineIds.length;
  model.message = `running ${model.totalJobs} engine jobs across ${workerCount} workers`;
  for (const engineId of engineIds) ensureDashboardEngine(model, engineId);
};

export const onDashboardScanStarted = (
  model: BenchDashboardModel,
  event: {
    readonly engineId: string;
    readonly assetId: string;
    readonly relativePath: string;
    readonly label?: EngineAssetResult['label'];
    readonly cached: boolean;
    readonly cacheable: boolean;
    readonly nowMs?: number;
  },
): void => {
  const engine = ensureDashboardEngine(model, event.engineId);
  if (event.cached) {
    engine.cacheHits += 1;
    return;
  }
  if (event.cacheable) {
    engine.cacheMisses += 1;
  }
  const nowMs = event.nowMs ?? Date.now();
  model.activeScans.set(activeScanKey(event.engineId, event.assetId), {
    engineId: event.engineId,
    assetId: event.assetId,
    relativePath: event.relativePath,
    ...(event.label === undefined ? {} : { label: event.label }),
    cached: event.cached,
    cacheable: event.cacheable,
    phase: 'scanning',
    startedAtMs: nowMs,
    updatedAtMs: nowMs,
  });
};

export const onDashboardImageLoadStarted = (
  model: BenchDashboardModel,
  event: {
    readonly engineId: string;
    readonly assetId: string;
    readonly relativePath: string;
    readonly label?: EngineAssetResult['label'];
    readonly nowMs?: number;
  },
): void => {
  const scan = getOrCreateActiveScan(model, event);
  scan.phase = 'loading-image';
  scan.updatedAtMs = event.nowMs ?? Date.now();
};

export const onDashboardImageLoadFinished = (
  model: BenchDashboardModel,
  event: {
    readonly engineId: string;
    readonly assetId: string;
    readonly nowMs?: number;
  },
): void => {
  const scan = model.activeScans.get(activeScanKey(event.engineId, event.assetId));
  if (!scan) return;
  scan.phase = 'scanning';
  scan.updatedAtMs = event.nowMs ?? Date.now();
};

export const onDashboardScanFinished = (
  model: BenchDashboardModel,
  event: {
    readonly engineId: string;
    readonly assetId: string;
    readonly relativePath: string;
    readonly result: EngineAssetResult;
    readonly wroteToCache: boolean;
    readonly nowMs?: number;
  },
): void => {
  const engine = ensureDashboardEngine(model, event.engineId);
  const nowMs = event.nowMs ?? Date.now();
  model.completedJobs += 1;
  engine.completed += 1;
  engine.lastOutcome = event.result.outcome;
  engine.lastDurationMs = event.result.durationMs;
  if (!event.result.cached) {
    engine.fresh += 1;
  }
  if (event.wroteToCache) {
    engine.cacheWrites += 1;
  }

  recordOutcome(engine, event.result);
  if (!event.result.cached) {
    recordTiming(engine, classifyTimingBucket(event.result), event.result.durationMs);
    recordSlowScan(model, event);
  }
  recordRecentScan(model, event, nowMs);
  model.activeScans.delete(activeScanKey(event.engineId, event.assetId));
};

export const onDashboardDone = (model: BenchDashboardModel): void => {
  model.stage = 'done';
  model.message = 'complete';
};

export const classifyTimingBucket = (result: EngineAssetResult): TimingBucketKey => {
  if (result.label === 'qr-positive') {
    return result.outcome === 'pass' || result.outcome === 'partial-pass'
      ? 'positive-pass'
      : 'positive-fail';
  }
  return result.outcome === 'pass' ? 'negative-pass' : 'negative-fail';
};

export const averageTimingMs = (bucket: TimingBucketStats): number | null => {
  if (bucket.count === 0) return null;
  return bucket.totalMs / bucket.count;
};

export const timingBucketKeys = (): readonly TimingBucketKey[] => TIMING_BUCKETS;

const recordOutcome = (engine: DashboardEngineStats, result: EngineAssetResult): void => {
  if (result.label === 'qr-positive') {
    if (result.outcome === 'pass') engine.qrPass += 1;
    else if (result.outcome === 'partial-pass') engine.qrPartial += 1;
    else if (result.outcome === 'fail-no-decode') engine.qrNoDecode += 1;
    else if (result.outcome === 'fail-mismatch') engine.qrMismatch += 1;
    else engine.qrErrors += 1;
    return;
  }

  if (result.outcome === 'pass') engine.negativePass += 1;
  else if (result.outcome === 'false-positive') engine.falsePositive += 1;
  else engine.negativeErrors += 1;
};

const recordTiming = (
  engine: DashboardEngineStats,
  key: TimingBucketKey,
  durationMs: number,
): void => {
  const current = engine.timing[key];
  engine.timing[key] = {
    count: current.count + 1,
    totalMs: current.totalMs + durationMs,
    maxMs: Math.max(current.maxMs, durationMs),
  };
};

const recordSlowScan = (
  model: BenchDashboardModel,
  event: {
    readonly engineId: string;
    readonly assetId: string;
    readonly relativePath: string;
    readonly result: EngineAssetResult;
  },
): void => {
  model.slowestFreshScans.push({
    engineId: event.engineId,
    assetId: event.assetId,
    relativePath: event.relativePath,
    label: event.result.label,
    outcome: event.result.outcome,
    durationMs: event.result.durationMs,
  });
  model.slowestFreshScans.sort((left, right) => right.durationMs - left.durationMs);
  if (model.slowestFreshScans.length > MAX_SLOWEST_FRESH_SCANS) {
    model.slowestFreshScans.splice(MAX_SLOWEST_FRESH_SCANS);
  }
};

const recordRecentScan = (
  model: BenchDashboardModel,
  event: {
    readonly engineId: string;
    readonly assetId: string;
    readonly relativePath: string;
    readonly result: EngineAssetResult;
  },
  finishedAtMs: number,
): void => {
  model.recentScans.push({
    finishedAtMs,
    engineId: event.engineId,
    assetId: event.assetId,
    relativePath: event.relativePath,
    result: event.result,
  });
  if (model.recentScans.length > MAX_RECENT_SCANS) {
    model.recentScans.splice(0, model.recentScans.length - MAX_RECENT_SCANS);
  }
};

const getOrCreateActiveScan = (
  model: BenchDashboardModel,
  event: {
    readonly engineId: string;
    readonly assetId: string;
    readonly relativePath: string;
    readonly label?: EngineAssetResult['label'];
    readonly nowMs?: number;
  },
): ActiveScan => {
  const key = activeScanKey(event.engineId, event.assetId);
  const existing = model.activeScans.get(key);
  if (existing) return existing;
  const nowMs = event.nowMs ?? Date.now();
  const created: ActiveScan = {
    engineId: event.engineId,
    assetId: event.assetId,
    relativePath: event.relativePath,
    ...(event.label === undefined ? {} : { label: event.label }),
    cached: false,
    cacheable: false,
    phase: 'queued',
    startedAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  model.activeScans.set(key, created);
  return created;
};

const activeScanKey = (engineId: string, assetId: string): string => `${engineId}:${assetId}`;
