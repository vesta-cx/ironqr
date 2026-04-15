import * as S from 'effect/Schema';
import {
  AutoScanSchema,
  type CorpusAsset,
  type CorpusAssetLabel,
  type CorpusManifest,
  CorpusRejectionReasonSchema,
  GroundTruthSchema,
  type ReviewStatus,
} from '../../schema.js';

/** Options for a full remote asset scrape-and-import run. */
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
  readonly log?: (line: string) => void;
  readonly fetchDelayMs?: number;
}

/** Result returned after importing staged remote assets into the corpus. */
export interface ImportRemoteAssetResult {
  readonly imported: readonly CorpusAsset[];
  readonly deduped: readonly CorpusAsset[];
  readonly manifest: CorpusManifest;
}

/** Schema for the review lifecycle status of a staged asset. */
export const StageReviewStatusSchema = S.Literals(['pending', 'approved', 'rejected']);
/** Review lifecycle status of a staged asset. */
export type StageReviewStatus = S.Schema.Type<typeof StageReviewStatusSchema>;

/** Schema for the human review record attached to a staged asset. */
export const StageReviewSchema = S.Struct({
  status: StageReviewStatusSchema,
  reviewer: S.optional(S.String),
  reviewedAt: S.optional(S.String),
  notes: S.optional(S.String),
});
/** Human review record attached to a staged asset. */
export type StageReview = S.Schema.Type<typeof StageReviewSchema>;

/** Schema for a remotely scraped image asset held in the staging area before import. */
export const StagedRemoteAssetSchema = S.Struct({
  version: S.Number,
  id: S.String,
  suggestedLabel: S.Literals(['qr-positive', 'non-qr-negative']),
  imageFileName: S.String,
  sourcePageUrl: S.String,
  imageUrl: S.String,
  seedUrl: S.String,
  sourceHost: S.String,
  fetchedAt: S.String,
  mediaType: S.String,
  byteLength: S.Number,
  sha256: S.String,
  sourceSha256: S.String,
  sourceMediaType: S.String,
  sourceByteLength: S.Number,
  width: S.Number,
  height: S.Number,
  pageTitle: S.optional(S.String),
  altText: S.optional(S.String),
  attributionText: S.optional(S.String),
  bestEffortLicense: S.optional(S.String),
  licenseEvidenceText: S.optional(S.String),
  review: StageReviewSchema,
  confirmedLicense: S.optional(S.String),
  groundTruth: S.optional(GroundTruthSchema),
  autoScan: S.optional(AutoScanSchema),
  importedAssetId: S.optional(S.String),
  rejectionReason: S.optional(CorpusRejectionReasonSchema),
});
/** A remotely scraped image asset held in the staging area before import. */
export type StagedRemoteAsset = S.Schema.Type<typeof StagedRemoteAssetSchema>;

/** Result of a completed synchronous scrape run. */
export interface ScrapeRemoteAssetsResult {
  readonly stageDir: string;
  readonly assets: readonly StagedRemoteAsset[];
}

/** Handle for an in-progress streaming scrape session. */
export interface ScrapeRemoteAssetsSession {
  readonly stageDir: string;
  readonly assets: AsyncIterable<StagedRemoteAsset>;
  readonly done: Promise<readonly StagedRemoteAsset[]>;
}

/** Options for promoting staged assets from the staging area into the corpus. */
export interface ImportStagedRemoteAssetsOptions {
  readonly repoRoot: string;
  readonly stageDir: string;
  readonly reviewStatus?: ReviewStatus;
  readonly reviewer?: string;
  readonly reviewNotes?: string;
  readonly overrideLabel?: CorpusAssetLabel;
  readonly attribution?: string;
  readonly license?: string;
  readonly provenanceNotes?: string;
}
