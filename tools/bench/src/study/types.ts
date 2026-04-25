import type { AccuracyEngineDescriptor, CorpusBenchAsset } from '../accuracy/types.js';

/** Stable identifier used in CLI args, report names, and cache keys. */
export type StudyPluginId = string;

export type StudyPluginFlagType = 'string' | 'number' | 'boolean';

export interface StudyPluginFlag {
  readonly name: string;
  readonly type: StudyPluginFlagType;
  readonly description: string;
  readonly default?: string | number | boolean;
}

export interface StudyPluginOutput {
  readonly reportFile: string;
  readonly cacheFile?: string;
}

export interface StudyReportReaders {
  readonly accuracy: () => Promise<unknown | null>;
  readonly performance: () => Promise<unknown | null>;
}

export interface StudyCacheHandle<AssetResult = unknown> {
  readonly read: (asset: CorpusBenchAsset, cacheKey: string) => Promise<AssetResult | null>;
  readonly write: (asset: CorpusBenchAsset, cacheKey: string, result: AssetResult) => Promise<void>;
  readonly summary: () => {
    readonly enabled: boolean;
    readonly file: string | null;
    readonly hits: number;
    readonly misses: number;
    readonly writes: number;
    readonly invalidRows: number;
  };
}

export interface StudyPluginContext {
  readonly repoRoot: string;
  readonly assets: readonly CorpusBenchAsset[];
  readonly output: StudyPluginOutput;
  readonly flags: Readonly<Record<string, string | number | boolean>>;
  readonly reports: StudyReportReaders;
  readonly cache: StudyCacheHandle;
  readonly signal?: AbortSignal;
  readonly log: (message: string) => void;
}

export interface StudyConfigContext {
  readonly flags: Readonly<Record<string, string | number | boolean>>;
  readonly assets: readonly CorpusBenchAsset[];
}

export interface StudyAssetInput<Config extends object> {
  readonly repoRoot: string;
  readonly asset: CorpusBenchAsset;
  readonly config: Config;
  readonly reports: StudyReportReaders;
  readonly cache: StudyCacheHandle<unknown>;
  readonly signal?: AbortSignal;
  readonly log: (message: string) => void;
}

export interface StudySummaryInput<Config extends object, AssetResult> {
  readonly config: Config;
  readonly assets: readonly CorpusBenchAsset[];
  readonly results: readonly AssetResult[];
  readonly cache: ReturnType<StudyCacheHandle<AssetResult>['summary']>;
}

export interface StudyPluginResult<Summary extends object = Record<string, unknown>> {
  readonly pluginId: StudyPluginId;
  readonly assetCount: number;
  readonly summary: Summary;
  readonly report: unknown;
}

export interface StudyPlugin<
  Summary extends object = Record<string, unknown>,
  Config extends object = Record<string, unknown>,
  AssetResult = unknown,
> {
  readonly id: StudyPluginId;
  readonly title: string;
  readonly description: string;
  readonly version: string;
  readonly flags?: readonly StudyPluginFlag[];

  /** Parse plugin-owned config from normalized flags. Generic study runner calls this once. */
  parseConfig?(context: StudyConfigContext): Config;
  /** Stable study-level cache dimension. Per-asset keys add id/hash/engine/observability. */
  cacheKey?(config: Config): string;
  /** Optional generic per-asset execution hook owned by the reusable study runner. */
  runAsset?(input: StudyAssetInput<Config>): Promise<AssetResult>;
  /** Summarize generic per-asset results after cache/resume completes. */
  summarize?(input: StudySummaryInput<Config, AssetResult>): Summary;
  /** Render study-specific report details from summarized generic results. */
  renderReport?(
    input: StudySummaryInput<Config, AssetResult> & { readonly summary: Summary },
  ): unknown;
  /** Engine/report metadata relevant to generic cache keys and report envelopes. */
  engines?(config: Config): readonly AccuracyEngineDescriptor[];
  /** Scanner or observability dimensions relevant to generic cache keys and report metadata. */
  observability?(config: Config): Record<string, unknown>;
  /** Skip runner-owned whole-asset cache so plugin can cache reusable sub-results itself. */
  readonly usesInternalCache?: boolean;

  /** Legacy escape hatch for plugins that need to own their whole execution loop. */
  run?(context: StudyPluginContext): Promise<StudyPluginResult<Summary>>;
}
