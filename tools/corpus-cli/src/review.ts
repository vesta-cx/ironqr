import {
  assertAllowedStagedAssetUrls,
  resolveStagedAssetPath,
  type StagedRemoteAsset,
  updateStagedRemoteAsset,
} from './import/remote.js';
import { isAutoRejectLicense } from './license.js';
import type { AutoScan, CorpusRejectionReason, GroundTruth } from './schema.js';

type ScanAssetResult = Omit<AutoScan, 'acceptedAsTruth'>;

interface ReviewStagedAssetsOptions {
  readonly stageDir: string;
  readonly reviewer: string;
  readonly assets: AsyncIterable<StagedRemoteAsset>;
  readonly promptConfirmedLicense: (
    asset: StagedRemoteAsset,
    suggestedLicense?: string,
  ) => Promise<string | undefined>;
  readonly promptAllowInCorpus: (asset: StagedRemoteAsset) => Promise<boolean>;
  readonly promptRejectReason: (asset: StagedRemoteAsset) => Promise<CorpusRejectionReason>;
  readonly promptQrCount: (asset: StagedRemoteAsset, initialValue?: number) => Promise<number>;
  readonly promptGroundTruth: (
    asset: StagedRemoteAsset,
    qrCount: number,
    scanResult: ScanAssetResult,
  ) => Promise<GroundTruth>;
  readonly scanAsset: (asset: StagedRemoteAsset) => Promise<ScanAssetResult>;
  readonly openSourcePage: (url: string) => Promise<void>;
  readonly log: (line: string) => void;
}

interface ReviewSummary {
  readonly approved: number;
  readonly rejected: number;
  readonly skipped: number;
}

const logAssetMetadata = (
  asset: StagedRemoteAsset,
  imagePath: string,
  log: (line: string) => void,
): void => {
  log(`Reviewing ${asset.id}`);
  log(`Source: ${asset.sourcePageUrl}`);
  log(`Image URL: ${asset.imageUrl}`);
  log(`Local: ${imagePath}`);
  log(`Size: ${asset.width}×${asset.height}`);
  if (asset.pageTitle) {
    log(`Page title: ${asset.pageTitle}`);
  }
  if (asset.bestEffortLicense) {
    log(`License hint: ${asset.bestEffortLicense}`);
  }
  if (asset.licenseEvidenceText) {
    log(`License evidence: ${asset.licenseEvidenceText}`);
  }
  if (asset.altText) {
    log(`Alt text: ${asset.altText}`);
  }
};

const groundTruthMatchesScan = (groundTruth: GroundTruth, scanResult: ScanAssetResult): boolean => {
  if (!scanResult.succeeded) return false;
  if (groundTruth.codes.length !== scanResult.results.length) return false;

  return groundTruth.codes.every((code, index) => code.text === scanResult.results[index]?.text);
};

const buildReviewedAsset = (
  asset: StagedRemoteAsset,
  updates: {
    readonly review: StagedRemoteAsset['review'];
    readonly suggestedLabel?: StagedRemoteAsset['suggestedLabel'];
    readonly confirmedLicense?: string;
    readonly groundTruth?: GroundTruth;
    readonly autoScan?: AutoScan;
  },
): StagedRemoteAsset => {
  const { confirmedLicense: _ignoredConfirmedLicense, ...assetWithoutConfirmedLicense } = asset;

  return {
    ...assetWithoutConfirmedLicense,
    ...(updates.suggestedLabel ? { suggestedLabel: updates.suggestedLabel } : {}),
    review: updates.review,
    ...(updates.confirmedLicense ? { confirmedLicense: updates.confirmedLicense } : {}),
    ...(updates.groundTruth ? { groundTruth: updates.groundTruth } : {}),
    ...(updates.autoScan ? { autoScan: updates.autoScan } : {}),
  };
};

/**
 * Iterate over staged assets and run the interactive review flow for each pending one.
 * @returns Counts of approved, rejected, and skipped assets.
 */
export const reviewStagedAssets = async (
  options: ReviewStagedAssetsOptions,
): Promise<ReviewSummary> => {
  let approved = 0;
  let rejected = 0;
  let skipped = 0;

  for await (const asset of options.assets) {
    if (asset.importedAssetId || asset.review.status !== 'pending') {
      skipped += 1;
      continue;
    }

    const imagePath = resolveStagedAssetPath(options.stageDir, asset.id, asset.imageFileName);
    assertAllowedStagedAssetUrls(asset);

    logAssetMetadata(asset, imagePath, options.log);
    await options.openSourcePage(asset.sourcePageUrl);

    const confirmedLicense = await options.promptConfirmedLicense(
      asset,
      asset.confirmedLicense ?? asset.bestEffortLicense,
    );

    if (confirmedLicense && isAutoRejectLicense(confirmedLicense)) {
      options.log(`Auto-rejected ${asset.id}: non-permissive license "${confirmedLicense}"`);
      await updateStagedRemoteAsset(options.stageDir, {
        ...buildReviewedAsset(asset, {
          review: {
            status: 'rejected',
            reviewer: options.reviewer,
            reviewedAt: new Date().toISOString(),
            notes: `Non-permissive license: ${confirmedLicense}`,
          },
          confirmedLicense,
        }),
        rejectionReason: 'license',
      });
      rejected += 1;
      continue;
    }

    const allowInCorpus = await options.promptAllowInCorpus(asset);

    if (!allowInCorpus) {
      const rejectionReason = await options.promptRejectReason(asset);
      const reviewed = buildReviewedAsset(asset, {
        review: {
          status: 'rejected',
          reviewer: options.reviewer,
          reviewedAt: new Date().toISOString(),
        },
        ...(confirmedLicense ? { confirmedLicense } : {}),
      });
      await updateStagedRemoteAsset(options.stageDir, { ...reviewed, rejectionReason });
      rejected += 1;
      continue;
    }

    const scanResult = await options.scanAsset(asset);
    const qrCount = await options.promptQrCount(
      asset,
      scanResult.succeeded ? scanResult.results.length : 0,
    );

    const groundTruth =
      qrCount === 0
        ? { qrCount: 0, codes: [] }
        : await options.promptGroundTruth(asset, qrCount, scanResult);

    const autoScan = toAutoScan(scanResult, groundTruthMatchesScan(groundTruth, scanResult));

    await updateStagedRemoteAsset(
      options.stageDir,
      buildReviewedAsset(asset, {
        suggestedLabel: qrCount === 0 ? 'qr-neg' : 'qr-pos',
        review: {
          status: 'approved',
          reviewer: options.reviewer,
          reviewedAt: new Date().toISOString(),
        },
        ...(confirmedLicense ? { confirmedLicense } : {}),
        groundTruth,
        autoScan,
      }),
    );
    approved += 1;
  }

  return { approved, rejected, skipped };
};

const toAutoScan = (result: ScanAssetResult, acceptedAsTruth?: boolean): AutoScan => ({
  ...result,
  ...(acceptedAsTruth !== undefined ? { acceptedAsTruth } : {}),
});

export type { ReviewStagedAssetsOptions, ReviewSummary };
