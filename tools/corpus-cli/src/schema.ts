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
  /** sha256 of the normalized on-disk bytes, used for file integrity checks. */
  sha256: S.String,
  byteLength: S.Number,
  /** sha256 of the original fetched/input bytes, used as the stable identity + dedup key. */
  sourceSha256: S.String,
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
  readonly groundTruth?: GroundTruth;
  readonly licenseReview?: LicenseReview;
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
  /** Delay in ms between page and image fetches to avoid rate limiting. Defaults to 1000. */
  readonly fetchDelayMs?: number;
}

export interface ImportRemoteAssetResult {
  readonly imported: readonly CorpusAsset[];
  readonly deduped: readonly CorpusAsset[];
  readonly manifest: CorpusManifest;
}

export const ScrapeProgressSchema = S.Struct({
  version: S.Literal(1),
  visitedSourcePageUrls: S.Array(S.String),
});
export type ScrapeProgress = S.Schema.Type<typeof ScrapeProgressSchema>;

// Open string — well-known values are 'license' | 'quality' | 'irrelevant' | 'duplicate'
// but reviewers can enter any custom reason.
export const CorpusRejectionReasonSchema = S.String;
export type CorpusRejectionReason = string;

export const CorpusRejectionEntrySchema = S.Struct({
  sourceSha256: S.String,
  reason: CorpusRejectionReasonSchema,
  notes: S.optional(S.String),
  sourcePageUrl: S.optional(S.String),
  imageUrl: S.optional(S.String),
  rejectedBy: S.optional(S.String),
  rejectedAt: S.String,
});
export type CorpusRejectionEntry = S.Schema.Type<typeof CorpusRejectionEntrySchema>;

export const CorpusRejectionsLogSchema = S.Struct({
  version: S.Literal(1),
  rejections: S.Array(CorpusRejectionEntrySchema),
});
export type CorpusRejectionsLog = S.Schema.Type<typeof CorpusRejectionsLogSchema>;

export const RealWorldBenchmarkEntrySchema = S.Struct({
  id: S.String,
  label: CorpusAssetLabelSchema,
  assetPath: S.String,
  sha256: S.String,
  byteLength: S.Number,
  mediaType: S.String,
  sourcePageUrl: S.optional(S.String),
  confirmedLicense: S.optional(S.String),
  attribution: S.optional(S.String),
  groundTruth: S.optional(GroundTruthSchema),
  autoScan: S.optional(AutoScanSchema),
});
export type RealWorldBenchmarkEntry = S.Schema.Type<typeof RealWorldBenchmarkEntrySchema>;

export const RealWorldBenchmarkCorpusSchema = S.Struct({
  positives: S.Array(RealWorldBenchmarkEntrySchema),
  negatives: S.Array(RealWorldBenchmarkEntrySchema),
});
export type RealWorldBenchmarkCorpus = S.Schema.Type<typeof RealWorldBenchmarkCorpusSchema>;
