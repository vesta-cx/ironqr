import * as S from 'effect/Schema';

export const CorpusAssetLabelSchema = S.Literals(['qr-positive', 'non-qr-negative']);
export type CorpusAssetLabel = S.Schema.Type<typeof CorpusAssetLabelSchema>;

export const ReviewStatusSchema = S.Literals(['pending', 'approved', 'rejected']);
export type ReviewStatus = S.Schema.Type<typeof ReviewStatusSchema>;

export const LocalSourceSchema = S.Struct({
  kind: S.Literal('local'),
  originalPath: S.String,
  importedAt: S.String,
  attribution: S.optional(S.String),
  license: S.optional(S.String),
  notes: S.optional(S.String),
});
export type LocalSource = S.Schema.Type<typeof LocalSourceSchema>;

export const RemoteSourceSchema = S.Struct({
  kind: S.Literal('remote'),
  sourcePageUrl: S.String,
  imageUrl: S.String,
  fetchedAt: S.String,
  pageTitle: S.optional(S.String),
  attribution: S.optional(S.String),
  license: S.optional(S.String),
  notes: S.optional(S.String),
});
export type RemoteSource = S.Schema.Type<typeof RemoteSourceSchema>;

export const ProvenanceRecordSchema = S.Union([LocalSourceSchema, RemoteSourceSchema]);
export type ProvenanceRecord = S.Schema.Type<typeof ProvenanceRecordSchema>;

export const AssetReviewSchema = S.Struct({
  status: ReviewStatusSchema,
  reviewer: S.optional(S.String),
  reviewedAt: S.optional(S.String),
  notes: S.optional(S.String),
});
export type AssetReview = S.Schema.Type<typeof AssetReviewSchema>;

export const GroundTruthCodeSchema = S.Struct({
  text: S.String,
  kind: S.optional(S.String),
  verifiedWith: S.optional(S.String),
  notes: S.optional(S.String),
});
export type GroundTruthCode = S.Schema.Type<typeof GroundTruthCodeSchema>;

export const GroundTruthSchema = S.Struct({
  qrCount: S.Number,
  codes: S.Array(GroundTruthCodeSchema),
});
export type GroundTruth = S.Schema.Type<typeof GroundTruthSchema>;

export const AutoScanCodeSchema = S.Struct({
  text: S.String,
  kind: S.optional(S.String),
});
export type AutoScanCode = S.Schema.Type<typeof AutoScanCodeSchema>;

export const AutoScanSchema = S.Struct({
  attempted: S.Boolean,
  succeeded: S.Boolean,
  results: S.Array(AutoScanCodeSchema),
  acceptedAsTruth: S.optional(S.Boolean),
});
export type AutoScan = S.Schema.Type<typeof AutoScanSchema>;

export const LicenseReviewSchema = S.Struct({
  bestEffortLicense: S.optional(S.String),
  licenseEvidenceText: S.optional(S.String),
  confirmedLicense: S.optional(S.String),
  licenseVerifiedBy: S.optional(S.String),
  licenseVerifiedAt: S.optional(S.String),
});
export type LicenseReview = S.Schema.Type<typeof LicenseReviewSchema>;

export const CorpusAssetSchema = S.Struct({
  id: S.String,
  label: CorpusAssetLabelSchema,
  mediaType: S.String,
  fileExtension: S.String,
  relativePath: S.String,
  sha256: S.String,
  byteLength: S.Number,
  provenance: S.Array(ProvenanceRecordSchema),
  review: AssetReviewSchema,
  groundTruth: S.optional(GroundTruthSchema),
  autoScan: S.optional(AutoScanSchema),
  licenseReview: S.optional(LicenseReviewSchema),
});
export type CorpusAsset = S.Schema.Type<typeof CorpusAssetSchema>;

export const CorpusManifestSchema = S.Struct({
  version: S.Literal(1),
  assets: S.Array(CorpusAssetSchema),
});
export type CorpusManifest = S.Schema.Type<typeof CorpusManifestSchema>;

export interface ImportLocalAssetOptions {
  readonly repoRoot: string;
  readonly paths: readonly string[];
  readonly label: CorpusAssetLabel;
  readonly reviewStatus?: ReviewStatus;
  readonly reviewer?: string;
  readonly reviewNotes?: string;
  readonly attribution?: string;
  readonly license?: string;
  readonly provenanceNotes?: string;
}

export interface ImportLocalAssetResult {
  readonly imported: readonly CorpusAsset[];
  readonly deduped: readonly CorpusAsset[];
  readonly manifest: CorpusManifest;
}

export interface ImportRemoteAssetOptions {
  readonly repoRoot: string;
  readonly seedUrls: readonly string[];
  readonly label: CorpusAssetLabel;
  readonly limit?: number;
  readonly reviewStatus?: ReviewStatus;
  readonly reviewer?: string;
  readonly reviewNotes?: string;
  readonly attribution?: string;
  readonly license?: string;
  readonly provenanceNotes?: string;
  /** Optional logger for skipped candidates and fetch failures. */
  readonly log?: (line: string) => void;
}

export interface ImportRemoteAssetResult {
  readonly imported: readonly CorpusAsset[];
  readonly deduped: readonly CorpusAsset[];
  readonly manifest: CorpusManifest;
}

export interface RealWorldBenchmarkEntry {
  readonly id: string;
  readonly label: CorpusAssetLabel;
  readonly assetPath: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly sourcePageUrl?: string;
  readonly confirmedLicense?: string;
  readonly groundTruth?: GroundTruth;
  readonly autoScan?: AutoScan;
}

export interface RealWorldBenchmarkCorpus {
  readonly positives: readonly RealWorldBenchmarkEntry[];
  readonly negatives: readonly RealWorldBenchmarkEntry[];
}
