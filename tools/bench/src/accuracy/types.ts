export interface AccuracyScanCode {
  readonly text: string;
  readonly kind?: string;
}

export interface AccuracyScanResult {
  readonly attempted: boolean;
  readonly succeeded: boolean;
  readonly results: readonly AccuracyScanCode[];
  readonly error?: string;
}

export interface AccuracyEngineCapabilities {
  readonly multiCode: boolean;
  readonly inversion: 'native' | 'caller' | 'none';
  readonly rotation: 'native' | 'none';
  readonly runtime: 'js' | 'wasm';
}

export interface AccuracyEngine {
  readonly id: string;
  readonly kind: 'first-party' | 'third-party';
  readonly capabilities: AccuracyEngineCapabilities;
  scanImage: (imagePath: string) => Promise<AccuracyScanResult>;
}

export type PositiveOutcomeKind =
  | 'pass'
  | 'partial-pass'
  | 'fail-mismatch'
  | 'fail-no-decode'
  | 'fail-error';

export type NegativeOutcomeKind = 'pass' | 'false-positive' | 'fail-error';

export interface PositiveOutcome {
  readonly kind: PositiveOutcomeKind;
  readonly decodedTexts: readonly string[];
  readonly matchedTexts: readonly string[];
  readonly expectedTexts: readonly string[];
  readonly error: string | null;
}

export interface NegativeOutcome {
  readonly kind: NegativeOutcomeKind;
  readonly decodedTexts: readonly string[];
  readonly error: string | null;
}

export interface EngineAssetResult {
  readonly engineId: string;
  readonly label: 'qr-positive' | 'non-qr-negative';
  readonly outcome: PositiveOutcomeKind | NegativeOutcomeKind;
  readonly decodedTexts: readonly string[];
  readonly matchedTexts: readonly string[];
  readonly error: string | null;
}

export interface AccuracyAssetResult {
  readonly assetId: string;
  readonly label: 'qr-positive' | 'non-qr-negative';
  readonly expectedTexts: readonly string[];
  readonly results: readonly EngineAssetResult[];
}

export interface AccuracyEngineSummary {
  readonly engineId: string;
  readonly positiveCount: number;
  readonly negativeCount: number;
  readonly fullPasses: number;
  readonly partialPasses: number;
  readonly positiveFailures: number;
  readonly falsePositives: number;
  readonly negativeErrors: number;
  readonly fullPassRate: number;
  readonly anyPassRate: number;
  readonly falsePositiveRate: number;
}

export interface AccuracyBenchmarkResult {
  readonly engines: readonly Pick<AccuracyEngine, 'id' | 'kind' | 'capabilities'>[];
  readonly assets: readonly AccuracyAssetResult[];
  readonly summaries: readonly AccuracyEngineSummary[];
}
