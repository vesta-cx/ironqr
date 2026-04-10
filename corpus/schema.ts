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

export const AssetReviewSchema = S.Struct({
  status: ReviewStatusSchema,
  reviewer: S.optional(S.String),
  reviewedAt: S.optional(S.String),
  notes: S.optional(S.String),
});
export type AssetReview = S.Schema.Type<typeof AssetReviewSchema>;

export const CorpusAssetSchema = S.Struct({
  id: S.String,
  label: CorpusAssetLabelSchema,
  mediaType: S.String,
  fileExtension: S.String,
  relativePath: S.String,
  sha256: S.String,
  byteLength: S.Number,
  provenance: S.Array(LocalSourceSchema),
  review: AssetReviewSchema,
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

export interface RealWorldBenchmarkEntry {
  readonly id: string;
  readonly label: CorpusAssetLabel;
  readonly assetPath: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
}

export interface RealWorldBenchmarkCorpus {
  readonly positives: readonly RealWorldBenchmarkEntry[];
  readonly negatives: readonly RealWorldBenchmarkEntry[];
}
