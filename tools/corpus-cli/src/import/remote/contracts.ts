import * as S from 'effect/Schema';
import type {
  CorpusAssetLabel,
  CorpusRejectionReason,
  ImportRemoteAssetResult,
  ReviewStatus,
} from '../../schema.js';
import { CorpusRejectionReasonSchema } from '../../schema.js';

export const StageReviewStatusSchema = S.Literals(['pending', 'approved', 'rejected', 'skipped']);
export type StageReviewStatus = S.Schema.Type<typeof StageReviewStatusSchema>;

export const StageReviewSchema = S.Struct({
  status: StageReviewStatusSchema,
  reviewer: S.optional(S.String),
  reviewedAt: S.optional(S.String),
  notes: S.optional(S.String),
});
export type StageReview = S.Schema.Type<typeof StageReviewSchema>;

export const StagedRemoteAssetSchema = S.Struct({
  version: S.Literal(1),
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
  groundTruth: S.optional(
    S.Struct({
      qrCount: S.Number,
      codes: S.Array(
        S.Struct({
          text: S.String,
          kind: S.optional(S.String),
          verifiedWith: S.optional(S.String),
          notes: S.optional(S.String),
        }),
      ),
    }),
  ),
  autoScan: S.optional(
    S.Struct({
      attempted: S.Boolean,
      succeeded: S.Boolean,
      results: S.Array(
        S.Struct({
          text: S.String,
          kind: S.optional(S.String),
        }),
      ),
      acceptedAsTruth: S.optional(S.Boolean),
    }),
  ),
  importedAssetId: S.optional(S.String),
  rejectionReason: S.optional(CorpusRejectionReasonSchema),
});
export type StagedRemoteAsset = S.Schema.Type<typeof StagedRemoteAssetSchema>;

export interface ScrapeRemoteAssetsResult {
  readonly stageDir: string;
  readonly assets: readonly StagedRemoteAsset[];
}

export interface ScrapeRemoteAssetsSession {
  readonly stageDir: string;
  readonly assets: AsyncIterable<StagedRemoteAsset>;
  readonly done: Promise<readonly StagedRemoteAsset[]>;
}

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

export type { CorpusRejectionReason, ImportRemoteAssetResult };
