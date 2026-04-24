import path from 'node:path';
import { getOption, type ParsedArgs, parseLabel, parseOptionalReviewStatus } from '../args.js';
import type { AppContext } from '../context.js';
import { importLocalAssets } from '../import/local.js';
import { getTrustedPlatformLicense } from '../import/remote/license-trust.js';
import {
  importStagedRemoteAssets,
  readStagedRemoteAssets,
  updateStagedRemoteAsset,
} from '../import/remote.js';
import type { CorpusAssetLabel, GroundTruth, ReviewStatus } from '../schema.js';

const resolveEffectiveReviewStatus = (
  assetStatus: ReviewStatus,
  override: ReviewStatus | undefined,
): ReviewStatus => (assetStatus === 'pending' ? (override ?? 'pending') : assetStatus);

import { assertInteractiveSession, isInteractiveSession } from '../tty.js';
import {
  buildAutoScanGroundTruth,
  isLikelyStageDir,
  listStageDirectories,
  promptLabel,
  promptLocalPaths,
  promptManualGroundTruth,
  promptOptionalText,
  promptQrCount,
  promptReviewStatus,
  promptStageDir,
  resolveReviewer,
} from './shared.js';

interface ImportCommandResult {
  readonly imported: number;
  readonly deduped: number;
  readonly total: number;
}

const resolveImportMode = async (
  context: AppContext,
  args: ParsedArgs,
  explicitStageDir?: string,
): Promise<'local' | 'staged'> => {
  if (explicitStageDir) {
    return 'staged';
  }

  if (args.positionals.length === 0) {
    assertInteractiveSession('Import target required in non-interactive mode');
    const stageDirs = await listStageDirectories(context.repoRoot);
    const options: Array<{
      value: 'local' | 'staged';
      label: string;
      hint: string;
    }> = [{ value: 'local', label: 'local files', hint: 'curated image files on disk' }];

    if (stageDirs.length > 0) {
      options.push({
        value: 'staged',
        label: 'staged scrape run',
        hint: 'approved assets from scrape review',
      });
    }

    return context.ui.select<'local' | 'staged'>({
      message: 'Import from',
      initialValue: stageDirs.length > 0 ? 'staged' : 'local',
      options,
    });
  }

  return args.positionals.length === 1 && (await isLikelyStageDir(args.positionals[0] ?? ''))
    ? 'staged'
    : 'local';
};

const promptSharedOptionalMetadata = async (
  context: AppContext,
  current: { attribution?: string; license?: string; notes?: string },
): Promise<{ attribution?: string; license?: string; provenanceNotes?: string }> => {
  const buildCurrentResult = () => ({
    ...(current.attribution ? { attribution: current.attribution } : {}),
    ...(current.license ? { license: current.license } : {}),
    ...(current.notes ? { provenanceNotes: current.notes } : {}),
  });

  if (!isInteractiveSession()) {
    return buildCurrentResult();
  }

  const wantsMore = await context.ui.confirm({
    message: 'Add attribution / license / notes?',
    initialValue: false,
  });

  if (!wantsMore) {
    return buildCurrentResult();
  }

  const attribution =
    current.attribution ?? (await promptOptionalText(context.ui, 'Attribution (optional)'));
  const license =
    current.license ??
    (await promptOptionalText(context.ui, 'License / permission basis (optional)'));
  const provenanceNotes =
    current.notes ?? (await promptOptionalText(context.ui, 'Provenance notes (optional)'));

  return {
    ...(attribution ? { attribution } : {}),
    ...(license ? { license } : {}),
    ...(provenanceNotes ? { provenanceNotes } : {}),
  };
};

const promptGroundTruthIfNeeded = async (
  context: AppContext,
  label: CorpusAssetLabel,
  reviewStatus: ReviewStatus,
): Promise<GroundTruth | undefined> => {
  if (label !== 'qr-pos' || reviewStatus !== 'approved') {
    return undefined;
  }

  if (!isInteractiveSession()) {
    return undefined;
  }

  const shouldRecord = await context.ui.confirm({
    message: 'Record ground truth now?',
    initialValue: true,
  });
  if (!shouldRecord) {
    return undefined;
  }

  const qrCount = await promptQrCount(context.ui);
  return qrCount === 0 ? { qrCount: 0, codes: [] } : promptManualGroundTruth(context.ui, qrCount);
};

const runLocalImport = async (
  context: AppContext,
  args: ParsedArgs,
): Promise<ImportCommandResult> => {
  const providedLabel = getOption(args, 'label');
  const label = providedLabel ? parseLabel(providedLabel) : await promptLabel(context.ui);
  const reviewOpt = getOption(args, 'review');
  const reviewStatus = reviewOpt
    ? parseOptionalReviewStatus(reviewOpt)
    : await promptReviewStatus(context.ui, 'approved');

  if (!reviewStatus) {
    throw new Error('Review status is required');
  }

  const paths =
    args.positionals.length > 0
      ? args.positionals.map((entry) => path.resolve(entry))
      : await promptLocalPaths(context.ui);

  const reviewer =
    reviewStatus === 'pending'
      ? undefined
      : await resolveReviewer(context, getOption(args, 'reviewer'));
  const attribution = getOption(args, 'attribution');
  const license = getOption(args, 'license');
  const notes = getOption(args, 'notes');
  const metadata = await promptSharedOptionalMetadata(context, {
    ...(attribution ? { attribution } : {}),
    ...(license ? { license } : {}),
    ...(notes ? { notes } : {}),
  });
  const groundTruth = await promptGroundTruthIfNeeded(context, label, reviewStatus);
  const reviewNotes = getOption(args, 'review-notes');
  const licenseReview =
    reviewStatus === 'approved' && metadata.license
      ? {
          confirmedLicense: metadata.license,
          ...(reviewer ? { licenseVerifiedBy: reviewer } : {}),
          licenseVerifiedAt: new Date().toISOString(),
        }
      : undefined;

  const result = await context.ui.spin('Importing local assets', () =>
    importLocalAssets({
      repoRoot: context.repoRoot,
      paths,
      label,
      reviewStatus,
      ...(reviewer ? { reviewer } : {}),
      ...(reviewNotes ? { reviewNotes } : {}),
      ...(metadata.attribution ? { attribution: metadata.attribution } : {}),
      ...(metadata.license ? { license: metadata.license } : {}),
      ...(metadata.provenanceNotes ? { provenanceNotes: metadata.provenanceNotes } : {}),
      ...(groundTruth ? { groundTruth } : {}),
      ...(licenseReview ? { licenseReview } : {}),
    }),
  );

  context.ui.info(
    `Imported ${result.imported.length}, deduped ${result.deduped.length}, total ${result.manifest.assets.length}`,
  );

  return {
    imported: result.imported.length,
    deduped: result.deduped.length,
    total: result.manifest.assets.length,
  };
};

interface FillMissingStagedMetadataOptions {
  readonly stageDir: string;
  readonly reviewStatus: ReviewStatus | undefined;
  readonly overrideLabel: CorpusAssetLabel | undefined;
  readonly reviewNotes: string | undefined;
  readonly attribution: string | undefined;
  readonly license: string | undefined;
  readonly provenanceNotes: string | undefined;
  readonly explicitReviewer?: string | undefined;
}

const fillMissingStagedMetadata = async (
  context: AppContext,
  opts: FillMissingStagedMetadataOptions,
): Promise<string | undefined> => {
  const {
    stageDir,
    reviewStatus,
    overrideLabel,
    reviewNotes,
    attribution,
    license,
    provenanceNotes,
    explicitReviewer,
  } = opts;
  const stagedAssets = await readStagedRemoteAssets(stageDir);
  let reviewer = explicitReviewer;

  for (const asset of stagedAssets) {
    if (asset.importedAssetId) {
      continue;
    }

    const effectiveReviewStatus = resolveEffectiveReviewStatus(asset.review.status, reviewStatus);
    if (effectiveReviewStatus !== 'approved') {
      continue;
    }

    const effectiveLabel = overrideLabel ?? asset.suggestedLabel;
    reviewer = asset.review.reviewer ?? reviewer;
    if (!reviewer) {
      reviewer = await resolveReviewer(context, undefined);
    }

    let confirmedLicense = asset.confirmedLicense ?? license ?? getTrustedPlatformLicense(asset);
    if (!confirmedLicense) {
      confirmedLicense = await context.ui.text({
        message: `Confirmed license for ${asset.id}`,
        ...(asset.bestEffortLicense ? { placeholder: asset.bestEffortLicense } : {}),
        validate: (value) =>
          value.trim().length > 0 ? undefined : 'Confirmed license is required',
      });
    }

    let groundTruth = asset.groundTruth;
    if (!groundTruth && effectiveLabel === 'qr-pos') {
      const qrCount = await promptQrCount(
        context.ui,
        `How many QR codes are present in ${asset.id}?`,
      );
      if (qrCount === 0) {
        groundTruth = { qrCount: 0, codes: [] };
      } else {
        const autoGroundTruth = asset.autoScan
          ? buildAutoScanGroundTruth(asset.autoScan, qrCount)
          : undefined;
        if (autoGroundTruth) {
          const acceptAuto = await context.ui.confirm({
            message: `Use saved auto-scan result for ${asset.id} as ground truth?`,
            initialValue: true,
          });
          groundTruth = acceptAuto
            ? autoGroundTruth
            : await promptManualGroundTruth(context.ui, qrCount);
        } else {
          groundTruth = await promptManualGroundTruth(context.ui, qrCount);
        }
      }
    }

    await updateStagedRemoteAsset(stageDir, {
      ...asset,
      review: {
        status: 'approved',
        ...(reviewer ? { reviewer } : {}),
        reviewedAt: asset.review.reviewedAt ?? new Date().toISOString(),
        ...((asset.review.notes ?? reviewNotes)
          ? { notes: asset.review.notes ?? reviewNotes }
          : {}),
      },
      ...(confirmedLicense ? { confirmedLicense } : {}),
      ...(groundTruth ? { groundTruth } : {}),
      ...(asset.bestEffortLicense || asset.licenseEvidenceText || confirmedLicense
        ? {
            bestEffortLicense: asset.bestEffortLicense,
            licenseEvidenceText: asset.licenseEvidenceText,
          }
        : {}),
    });
  }

  return reviewer;
};

const runStagedImport = async (
  context: AppContext,
  args: ParsedArgs,
  explicitStageDir?: string,
): Promise<ImportCommandResult> => {
  const reviewStatus = parseOptionalReviewStatus(getOption(args, 'review'));
  const labelOpt = getOption(args, 'label');
  const overrideLabel = labelOpt ? parseLabel(labelOpt) : undefined;
  const reviewNotes = getOption(args, 'review-notes');
  const attribution = getOption(args, 'attribution');
  const license = getOption(args, 'license');
  const provenanceNotes = getOption(args, 'notes');
  const stageDir = await promptStageDir(context, explicitStageDir ?? args.positionals[0]);

  const stagedAssets = await readStagedRemoteAssets(stageDir);
  const approvedCount = stagedAssets.filter((asset) => {
    return (
      !asset.importedAssetId &&
      resolveEffectiveReviewStatus(asset.review.status, reviewStatus) === 'approved'
    );
  }).length;

  if (approvedCount === 0) {
    throw new Error(
      'No approved staged assets to import. Run corpus review first or pass --review approved.',
    );
  }

  const reviewerOpt = getOption(args, 'reviewer');
  const reviewer = await fillMissingStagedMetadata(context, {
    stageDir,
    reviewStatus,
    overrideLabel,
    reviewNotes,
    attribution,
    license,
    provenanceNotes,
    ...(reviewerOpt ? { explicitReviewer: reviewerOpt } : {}),
  });

  const result = await context.ui.spin('Importing staged assets', () =>
    importStagedRemoteAssets({
      repoRoot: context.repoRoot,
      stageDir,
      ...(reviewStatus ? { reviewStatus } : {}),
      ...(reviewer ? { reviewer } : {}),
      ...(reviewNotes ? { reviewNotes } : {}),
      ...(overrideLabel ? { overrideLabel } : {}),
      ...(attribution ? { attribution } : {}),
      ...(license ? { license } : {}),
      ...(provenanceNotes ? { provenanceNotes } : {}),
    }),
  );

  context.ui.info(
    `Imported ${result.imported.length}, deduped ${result.deduped.length}, total ${result.manifest.assets.length}`,
  );

  return {
    imported: result.imported.length,
    deduped: result.deduped.length,
    total: result.manifest.assets.length,
  };
};

export const runImportCommand = async (
  context: AppContext,
  args: ParsedArgs,
  explicitStageDir?: string,
): Promise<ImportCommandResult> => {
  const mode = await resolveImportMode(context, args, explicitStageDir);
  return mode === 'staged'
    ? runStagedImport(context, args, explicitStageDir)
    : runLocalImport(context, args);
};
