import {
  readStagedRemoteAssets,
  resolveStagedAssetPath,
  type StagedRemoteAsset,
  type StageReviewStatus,
  updateStagedRemoteAsset,
} from './import/remote.js';
import type { AutoScan, GroundTruth } from './schema.js';
import { assertHttpUrl } from './url.js';

interface ScanAssetResult {
  readonly attempted: boolean;
  readonly succeeded: boolean;
  readonly results: ReadonlyArray<{
    readonly text: string;
    readonly kind?: string | undefined;
  }>;
}

interface ReviewStagedAssetsOptions {
  readonly stageDir: string;
  readonly reviewer: string;
  readonly prompt: (message: string) => Promise<string>;
  readonly scanAsset: (asset: StagedRemoteAsset) => Promise<ScanAssetResult>;
  readonly openLocalImage: (filePath: string) => Promise<void>;
  readonly openSourcePage: (url: string) => Promise<void>;
  readonly log: (line: string) => void;
}

interface ReviewSummary {
  readonly approved: number;
  readonly rejected: number;
  readonly skipped: number;
  readonly quitEarly: boolean;
}

export const reviewStagedAssets = async (
  options: ReviewStagedAssetsOptions,
): Promise<ReviewSummary> => {
  const assets = await readStagedRemoteAssets(options.stageDir);
  let approved = 0;
  let rejected = 0;
  let skipped = 0;

  for (const asset of assets) {
    if (asset.importedAssetId || asset.review.status !== 'pending') {
      continue;
    }

    const imagePath = resolveStagedAssetPath(options.stageDir, asset.id, asset.imageFileName);
    assertHttpUrl(asset.sourcePageUrl, 'source page URL');

    options.log(`Reviewing ${asset.id}`);
    options.log(`Source: ${asset.sourcePageUrl}`);
    options.log(`Local: ${imagePath}`);

    while (true) {
      const action = (
        await options.prompt('Action [a]pprove, [r]eject, [s]kip, [o]pen source, [i]mage, [q]uit:')
      )
        .trim()
        .toLowerCase();

      if (action === 'o') {
        await options.openSourcePage(asset.sourcePageUrl);
        continue;
      }

      if (action === 'i') {
        await options.openLocalImage(imagePath);
        continue;
      }

      if (action === 's' || action === '') {
        await updateStagedRemoteAsset(options.stageDir, {
          ...asset,
          review: {
            status: 'skipped',
            reviewer: options.reviewer,
            reviewedAt: new Date().toISOString(),
          },
        });
        skipped += 1;
        break;
      }

      if (action === 'q') {
        return { approved, rejected, skipped, quitEarly: true };
      }

      if (action === 'r') {
        const notes = await options.prompt('Rejection notes (optional):');
        await updateStagedRemoteAsset(options.stageDir, {
          ...asset,
          review: {
            status: 'rejected',
            reviewer: options.reviewer,
            reviewedAt: new Date().toISOString(),
            ...(notes ? { notes } : {}),
          },
        });
        rejected += 1;
        break;
      }

      if (action === 'a') {
        const confirmedLicense = await options.prompt(
          `Confirm license [default: ${asset.bestEffortLicense ?? 'unknown'}]:`,
        );
        const qrCount = await promptQrCount(options.prompt, options.log);

        const scanResult = await options.scanAsset(asset);
        let groundTruth: GroundTruth;
        let autoScan: AutoScan;

        if (qrCount === 0) {
          groundTruth = { qrCount: 0, codes: [] };
          autoScan = toAutoScan(scanResult, scanResult.results.length === 0);
        } else if (scanResult.succeeded && scanResult.results.length === qrCount) {
          const accept = (await options.prompt('Accept auto-scan results as ground truth? [y/N]:'))
            .trim()
            .toLowerCase();
          if (accept === 'y') {
            groundTruth = {
              qrCount,
              codes: scanResult.results.map((entry) => ({
                text: entry.text,
                ...(entry.kind ? { kind: entry.kind } : {}),
              })),
            };
            autoScan = toAutoScan(scanResult, true);
          } else {
            groundTruth = await promptManualGroundTruth(options.prompt, qrCount);
            autoScan = toAutoScan(scanResult, false);
          }
        } else {
          groundTruth = await promptManualGroundTruth(options.prompt, qrCount);
          autoScan = toAutoScan(scanResult, false);
        }

        await updateStagedRemoteAsset(options.stageDir, {
          ...asset,
          review: {
            status: 'approved',
            reviewer: options.reviewer,
            reviewedAt: new Date().toISOString(),
          },
          ...(confirmedLicense || asset.bestEffortLicense
            ? { confirmedLicense: confirmedLicense || asset.bestEffortLicense }
            : {}),
          groundTruth,
          autoScan,
        });
        approved += 1;
        break;
      }
    }
  }

  return { approved, rejected, skipped, quitEarly: false };
};

const promptQrCount = async (
  prompt: (message: string) => Promise<string>,
  log: (line: string) => void,
): Promise<number> => {
  while (true) {
    const value = (await prompt('How many QR codes are present in this image?')).trim();
    if (value === '') {
      log('QR count is required.');
      continue;
    }

    const qrCount = Number(value);
    if (Number.isInteger(qrCount) && qrCount >= 0) {
      return qrCount;
    }

    log(`Invalid QR count: ${value}`);
  }
};

const promptManualGroundTruth = async (
  prompt: (message: string) => Promise<string>,
  qrCount: number,
): Promise<GroundTruth> => {
  const codes: Array<GroundTruth['codes'][number]> = [];

  for (let index = 0; index < qrCount; index += 1) {
    const label = index + 1;
    const text = await prompt(`QR #${label} text:`);
    const kind = await prompt(`QR #${label} kind (optional):`);
    const verifiedWith = await prompt(`QR #${label} verified with (optional):`);

    codes.push({
      text,
      ...(kind ? { kind } : {}),
      ...(verifiedWith ? { verifiedWith } : {}),
    });
  }

  return { qrCount, codes };
};

const toAutoScan = (result: ScanAssetResult, acceptedAsTruth?: boolean): AutoScan => {
  return {
    attempted: result.attempted,
    succeeded: result.succeeded,
    results: result.results.map((entry) => ({
      text: entry.text,
      ...(entry.kind ? { kind: entry.kind } : {}),
    })),
    ...(acceptedAsTruth !== undefined ? { acceptedAsTruth } : {}),
  };
};

export type { ReviewStagedAssetsOptions, ReviewSummary, ScanAssetResult, StageReviewStatus };
