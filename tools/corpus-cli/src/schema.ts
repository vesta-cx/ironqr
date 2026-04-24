import * as S from 'effect/Schema';

export const CORPUS_ASSET_LABELS = ['qr-positive', 'non-qr-negative'] as const;
export const REVIEW_STATUSES = ['pending', 'approved', 'rejected'] as const;

/** Schema for the corpus asset classification label. */
export const CorpusAssetLabelSchema = S.Literals(CORPUS_ASSET_LABELS);
/** Whether an asset contains QR codes (`qr-positive`) or should not decode as one (`non-qr-negative`). */
export type CorpusAssetLabel = S.Schema.Type<typeof CorpusAssetLabelSchema>;

/** Schema for the human-review status of a corpus asset. */
export const ReviewStatusSchema = S.Literals(REVIEW_STATUSES);
/** Human-review lifecycle state of a corpus asset. */
export type ReviewStatus = S.Schema.Type<typeof ReviewStatusSchema>;

/** Schema for a locally imported image provenance record. */
export const LocalSourceSchema = S.Struct({
  kind: S.Literal('local'),
  originalPath: S.String,
  importedAt: S.String,
  attribution: S.optional(S.String),
  license: S.optional(S.String),
  notes: S.optional(S.String),
});
/** Provenance record for an image imported from a local file path. */
export type LocalSource = S.Schema.Type<typeof LocalSourceSchema>;

/** Schema for a remotely fetched image provenance record. */
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
/** Provenance record for an image fetched from a remote URL. */
export type RemoteSource = S.Schema.Type<typeof RemoteSourceSchema>;

/** Schema for a corpus asset provenance record (local or remote). */
export const ProvenanceRecordSchema = S.Union([LocalSourceSchema, RemoteSourceSchema]);
/** A single provenance entry describing where an asset came from. */
export type ProvenanceRecord = S.Schema.Type<typeof ProvenanceRecordSchema>;

/** Schema for the human-review record attached to a corpus asset. */
export const AssetReviewSchema = S.Struct({
  status: ReviewStatusSchema,
  reviewer: S.optional(S.String),
  reviewedAt: S.optional(S.String),
  notes: S.optional(S.String),
});
/** Human-review record for a corpus asset, including status, reviewer, and notes. */
export type AssetReview = S.Schema.Type<typeof AssetReviewSchema>;

/** Schema for a single verified QR code payload within ground truth. */
export const GroundTruthCodeSchema = S.Struct({
  text: S.String,
  kind: S.optional(S.String),
  verifiedWith: S.optional(S.String),
  notes: S.optional(S.String),
});
/** A single verified QR code entry in the ground truth record. */
export type GroundTruthCode = S.Schema.Type<typeof GroundTruthCodeSchema>;

/** Schema for the verified QR ground truth of a corpus asset. */
export const GroundTruthSchema = S.Struct({
  qrCount: S.Number,
  codes: S.Array(GroundTruthCodeSchema),
});
/** Verified QR code ground truth for a corpus asset. */
export type GroundTruth = S.Schema.Type<typeof GroundTruthSchema>;

/** Schema for a single QR code result from an automated scan. */
export const AutoScanCodeSchema = S.Struct({
  text: S.String,
  kind: S.optional(S.String),
});
/** A single decoded QR code entry from an automated scan. */
export type AutoScanCode = S.Schema.Type<typeof AutoScanCodeSchema>;

/** Schema for the result of an automated QR scan attempt on a corpus asset. */
export const AutoScanSchema = S.Struct({
  attempted: S.Boolean,
  succeeded: S.Boolean,
  results: S.Array(AutoScanCodeSchema),
  acceptedAsTruth: S.optional(S.Boolean),
});
/** Result of an automated QR scan, including whether it succeeded and what was found. */
export type AutoScan = S.Schema.Type<typeof AutoScanSchema>;

/** Schema for the license-review metadata attached to a corpus asset. */
export const LicenseReviewSchema = S.Struct({
  bestEffortLicense: S.optional(S.String),
  licenseEvidenceText: S.optional(S.String),
  confirmedLicense: S.optional(S.String),
  licenseVerifiedBy: S.optional(S.String),
  licenseVerifiedAt: S.optional(S.String),
});
/** License review metadata for a corpus asset, including confirmed license and verifier. */
export type LicenseReview = S.Schema.Type<typeof LicenseReviewSchema>;

const SyntheticScalarSchema = S.Union([S.String, S.Number, S.Boolean]);

/** Schema for the appearance settings used to render a generated QR asset. */
export const SyntheticAppearanceSchema = S.Struct({
  errorCorrection: S.String,
  pixelSize: S.Number,
  moduleStyle: S.String,
  capStyle: S.String,
  connectionMode: S.String,
  dotSize: S.Number,
  fgColor: S.String,
  bgColor: S.String,
  themeId: S.optional(S.String),
  frameText: S.optional(S.String),
  quietZoneModules: S.optional(S.Number),
});
/** Appearance settings used to render a generated QR asset. */
export type SyntheticAppearance = S.Schema.Type<typeof SyntheticAppearanceSchema>;

/** Schema for a single transformation applied to a generated QR asset. */
export const SyntheticTransformationSchema = S.Struct({
  kind: S.String,
  recipeId: S.optional(S.String),
  axis: S.optional(S.String),
  direction: S.optional(S.String),
  amount: S.optional(S.Number),
  mode: S.optional(S.String),
  opacity: S.optional(S.Number),
  scale: S.optional(S.Number),
  offsetX: S.optional(S.Number),
  offsetY: S.optional(S.Number),
  quality: S.optional(S.Number),
  backgroundAssetId: S.optional(S.String),
  backgroundAssetPath: S.optional(S.String),
  parameters: S.optional(S.Record(S.String, SyntheticScalarSchema)),
});
/** A single transformation applied to a generated QR asset. */
export type SyntheticTransformation = S.Schema.Type<typeof SyntheticTransformationSchema>;

/** Schema for metadata attached to generated QR assets and their derived variants. */
export const SyntheticAssetMetadataSchema = S.Struct({
  source: S.Literal('generated'),
  generator: S.String,
  generatorVersion: S.optional(S.String),
  variantKind: S.Literals(['base', 'derived']),
  seed: S.String,
  payloadType: S.String,
  payloadFields: S.Record(S.String, SyntheticScalarSchema),
  encodedData: S.String,
  appearance: SyntheticAppearanceSchema,
  transformations: S.Array(SyntheticTransformationSchema),
  recipeId: S.optional(S.String),
  parentAssetIds: S.optional(S.Array(S.String)),
});
/** Metadata attached to generated QR assets and their derived variants. */
export type SyntheticAssetMetadata = S.Schema.Type<typeof SyntheticAssetMetadataSchema>;

/** Schema for a single corpus asset entry in the manifest. */
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
  synthetic: S.optional(SyntheticAssetMetadataSchema),
});
/** A single corpus asset record stored in `manifest.json`. */
export type CorpusAsset = S.Schema.Type<typeof CorpusAssetSchema>;

/** Schema for the top-level corpus manifest file. */
export const CorpusManifestSchema = S.Struct({
  version: S.Number,
  assets: S.Array(CorpusAssetSchema),
});
/** The root corpus manifest containing all asset records. */
export type CorpusManifest = S.Schema.Type<typeof CorpusManifestSchema>;

/** Schema for the persistent scrape-progress tracking file. */
export const ScrapeProgressSchema = S.Struct({
  version: S.Number,
  visitedSourcePageUrls: S.Array(S.String),
});
/** Persistent record of source-page URLs already visited during scraping. */
export type ScrapeProgress = S.Schema.Type<typeof ScrapeProgressSchema>;

// Open string — well-known values are 'license' | 'quality' | 'irrelevant' | 'duplicate'
// but reviewers can enter any custom reason.
/** Schema for a corpus asset rejection reason (open string). */
export const CorpusRejectionReasonSchema = S.String;
/** Human-readable reason an asset was rejected; may be a well-known value or a custom string. */
export type CorpusRejectionReason = string;

/** Schema for a single entry in the rejections log. */
export const CorpusRejectionEntrySchema = S.Struct({
  sourceSha256: S.String,
  reason: CorpusRejectionReasonSchema,
  notes: S.optional(S.String),
  sourcePageUrl: S.optional(S.String),
  imageUrl: S.optional(S.String),
  rejectedBy: S.optional(S.String),
  rejectedAt: S.String,
});
/** A single rejection log entry identifying a rejected asset by its source SHA-256. */
export type CorpusRejectionEntry = S.Schema.Type<typeof CorpusRejectionEntrySchema>;

/** Schema for the top-level rejections log file. */
export const CorpusRejectionsLogSchema = S.Struct({
  version: S.Number,
  rejections: S.Array(CorpusRejectionEntrySchema),
});
/** The root rejections log containing all rejection entries. */
export type CorpusRejectionsLog = S.Schema.Type<typeof CorpusRejectionsLogSchema>;

/** Schema for a single entry in the real-world benchmark corpus. */
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
/** A single asset entry exported to the real-world benchmark corpus. */
export type RealWorldBenchmarkEntry = S.Schema.Type<typeof RealWorldBenchmarkEntrySchema>;

/** Schema for the full real-world benchmark corpus, split into positives and negatives. */
export const RealWorldBenchmarkCorpusSchema = S.Struct({
  positives: S.Array(RealWorldBenchmarkEntrySchema),
  negatives: S.Array(RealWorldBenchmarkEntrySchema),
});
/** The real-world benchmark corpus, partitioned into QR-positive and non-QR-negative entries. */
export type RealWorldBenchmarkCorpus = S.Schema.Type<typeof RealWorldBenchmarkCorpusSchema>;
