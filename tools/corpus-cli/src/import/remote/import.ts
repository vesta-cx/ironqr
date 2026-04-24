import { readFile } from 'node:fs/promises';
import { Effect } from 'effect';
import { appendCorpusRejection, readCorpusManifest, writeCorpusManifest } from '../../manifest.js';
import type { CorpusAsset, LicenseReview, RemoteSource } from '../../schema.js';
import { MAJOR_VERSION } from '../../version.js';
import { importAssetBytesEffect } from '../store.js';
import type {
  ImportRemoteAssetResult,
  ImportStagedRemoteAssetsOptions,
  StagedRemoteAsset,
} from './contracts.js';
import { tryPromise } from './effect.js';
import { getTrustedPlatformLicense } from './license-trust.js';
import {
  getAssetImagePath,
  readStagedRemoteAssetsEffect,
  removeRunDirIfEmptyEffect,
  removeStagedAssetDirEffect,
} from './stage-store.js';

const buildRemoteSource = (
  asset: StagedRemoteAsset,
  options: ImportStagedRemoteAssetsOptions,
): RemoteSource => {
  const license = asset.confirmedLicense ?? options.license ?? getTrustedPlatformLicense(asset);
  return {
    kind: 'remote',
    sourcePageUrl: asset.sourcePageUrl,
    imageUrl: asset.imageUrl,
    fetchedAt: asset.fetchedAt,
    ...(asset.pageTitle ? { pageTitle: asset.pageTitle } : {}),
    ...(options.attribution
      ? { attribution: options.attribution }
      : asset.attributionText
        ? { attribution: asset.attributionText }
        : {}),
    ...(license ? { license } : {}),
    ...(options.provenanceNotes ? { notes: options.provenanceNotes } : {}),
  };
};

const buildLicenseReview = (
  asset: StagedRemoteAsset,
  reviewer?: string,
): LicenseReview | undefined => {
  const confirmedLicense = asset.confirmedLicense ?? getTrustedPlatformLicense(asset);
  if (!asset.bestEffortLicense && !asset.licenseEvidenceText && !confirmedLicense) {
    return undefined;
  }

  return {
    ...(asset.bestEffortLicense ? { bestEffortLicense: asset.bestEffortLicense } : {}),
    ...(asset.licenseEvidenceText ? { licenseEvidenceText: asset.licenseEvidenceText } : {}),
    ...(confirmedLicense ? { confirmedLicense } : {}),
    ...(reviewer ? { licenseVerifiedBy: reviewer } : {}),
    ...(asset.review.reviewedAt ? { licenseVerifiedAt: asset.review.reviewedAt } : {}),
  };
};

const importStagedRemoteAssetsEffect = (options: ImportStagedRemoteAssetsOptions) => {
  return Effect.gen(function* () {
    const stagedAssets = yield* readStagedRemoteAssetsEffect(options.stageDir);
    const manifest = yield* tryPromise(() => readCorpusManifest(options.repoRoot));
    const assets = [...manifest.assets];
    const imported: CorpusAsset[] = [];
    const deduped: CorpusAsset[] = [];
    const idsToDelete: string[] = [];

    for (const stagedAsset of stagedAssets) {
      const effectiveReviewStatus =
        stagedAsset.review.status === 'pending'
          ? (options.reviewStatus ?? 'pending')
          : stagedAsset.review.status;

      if (effectiveReviewStatus === 'rejected') {
        yield* tryPromise(() =>
          appendCorpusRejection(options.repoRoot, {
            sourceSha256: stagedAsset.sourceSha256,
            reason: stagedAsset.rejectionReason ?? 'other',
            ...(stagedAsset.review.notes ? { notes: stagedAsset.review.notes } : {}),
            sourcePageUrl: stagedAsset.sourcePageUrl,
            imageUrl: stagedAsset.imageUrl,
            ...(stagedAsset.review.reviewer ? { rejectedBy: stagedAsset.review.reviewer } : {}),
            rejectedAt: stagedAsset.review.reviewedAt ?? new Date().toISOString(),
          }),
        );
        idsToDelete.push(stagedAsset.id);
        continue;
      }

      if (effectiveReviewStatus !== 'approved') {
        continue;
      }

      const reviewer = stagedAsset.review.reviewer ?? options.reviewer;
      const reviewNotes = stagedAsset.review.notes ?? options.reviewNotes;
      const reviewedAt = stagedAsset.review.reviewedAt ?? new Date().toISOString();
      const approvedAsset: StagedRemoteAsset = {
        ...stagedAsset,
        review: {
          status: 'approved',
          ...(reviewer ? { reviewer } : {}),
          reviewedAt,
          ...(reviewNotes ? { notes: reviewNotes } : {}),
        },
      };

      const sourcePath = getAssetImagePath(options.stageDir, approvedAsset);
      const bytes = yield* tryPromise(() => readFile(sourcePath));
      const licenseReview = buildLicenseReview(approvedAsset, reviewer);
      const result = yield* importAssetBytesEffect({
        repoRoot: options.repoRoot,
        assets,
        bytes,
        sourcePathForExtension: approvedAsset.imageUrl,
        label:
          options.overrideLabel ??
          (approvedAsset.groundTruth
            ? approvedAsset.groundTruth.qrCount === 0
              ? 'non-qr-negative'
              : 'qr-positive'
            : approvedAsset.suggestedLabel),
        provenance: buildRemoteSource(approvedAsset, options),
        sourceSha256: approvedAsset.sourceSha256,
        reviewStatus: 'approved',
        ...(reviewer ? { reviewer } : {}),
        ...(reviewNotes ? { reviewNotes } : {}),
        ...(approvedAsset.review.reviewedAt ? { reviewedAt: approvedAsset.review.reviewedAt } : {}),
        ...(approvedAsset.groundTruth ? { groundTruth: approvedAsset.groundTruth } : {}),
        ...(approvedAsset.autoScan ? { autoScan: approvedAsset.autoScan } : {}),
        ...(licenseReview ? { licenseReview } : {}),
      });

      if (result.deduped) {
        deduped.push(result.asset);
      } else {
        imported.push(result.asset);
      }

      idsToDelete.push(stagedAsset.id);
    }

    const nextManifest = { version: MAJOR_VERSION, assets };
    yield* tryPromise(() => writeCorpusManifest(options.repoRoot, nextManifest));

    for (const id of idsToDelete) {
      yield* removeStagedAssetDirEffect(options.stageDir, id);
    }

    yield* removeRunDirIfEmptyEffect(options.stageDir);

    return {
      imported,
      deduped,
      manifest: nextManifest,
    } satisfies ImportRemoteAssetResult;
  });
};

/**
 * Promotes approved staged assets into the corpus manifest and removes their staging directories.
 * Rejected assets are written to the rejections log and also cleaned up.
 */
export const importStagedRemoteAssets = (
  options: ImportStagedRemoteAssetsOptions,
): Promise<ImportRemoteAssetResult> => {
  return Effect.runPromise(importStagedRemoteAssetsEffect(options));
};
