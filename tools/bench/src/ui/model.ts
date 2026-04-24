export type {
  ActiveScan,
  BenchDashboardModel as BenchRunModel,
  DashboardEngineStats as BenchRunEngineStats,
  DashboardStage as BenchRunPhase,
  RecentScan,
  SlowScan,
  TimingBucketStats,
  TimingBuckets,
} from '../accuracy/dashboard/model.js';

export {
  averageTimingMs,
  classifyTimingBucket,
  createBenchDashboardModel as createBenchRunModel,
  ensureDashboardEngine as ensureBenchRunEngine,
  onDashboardAssetPrepared as onBenchRunAssetPrepared,
  onDashboardAssetsStarted as onBenchRunAssetsStarted,
  onDashboardBenchmarkStarted as onBenchRunBenchmarkStarted,
  onDashboardDone as onBenchRunDone,
  onDashboardImageLoadFinished as onBenchRunImageLoadFinished,
  onDashboardImageLoadStarted as onBenchRunImageLoadStarted,
  onDashboardManifestLoaded as onBenchRunManifestLoaded,
  onDashboardManifestStarted as onBenchRunManifestStarted,
  onDashboardScanFinished as onBenchRunScanFinished,
  onDashboardScanStarted as onBenchRunScanStarted,
  timingBucketKeys,
} from '../accuracy/dashboard/model.js';
