import path from 'node:path';
import { getOption, type ParsedArgs } from '../args.js';
import { buildFilteredCliCommand } from '../command-text.js';
import type { AppContext } from '../context.js';
import {
  resolveStagedAssetPath,
  type StagedRemoteAsset,
  streamStagedRemoteAssets,
} from '../import/remote.js';
import { type ReviewSummary, reviewStagedAssets } from '../review.js';
import { scanLocalImageFile } from '../scan.js';
import {
  promptManualGroundTruth,
  promptQrCount,
  promptStageDir,
  resolveReviewer,
} from './shared.js';

interface ReviewCommandResult {
  readonly stageDir: string;
  readonly reviewer: string;
  readonly summary: ReviewSummary;
}

export const runReviewCommand = async (
  context: AppContext,
  args: ParsedArgs,
  explicitStageDir?: string,
  explicitReviewer?: string,
  explicitAssets?: AsyncIterable<StagedRemoteAsset>,
): Promise<ReviewCommandResult> => {
  const stageDir = await promptStageDir(context, explicitStageDir ?? args.positionals[0]);
  const reviewer = await resolveReviewer(context, explicitReviewer ?? getOption(args, 'reviewer'));

  if (!reviewer) {
    throw new Error('Reviewer GitHub username is required for review');
  }

  const summary = await reviewStagedAssets({
    stageDir,
    reviewer,
    assets: explicitAssets ?? streamStagedRemoteAssets(stageDir),
    promptConfirmedLicense: async (asset, suggestedLicense) => {
      if (suggestedLicense) {
        const keep = await context.ui.confirm({
          message: `Keep detected license for ${asset.id}: ${suggestedLicense}?`,
          initialValue: true,
        });
        if (keep) {
          return suggestedLicense;
        }
      }

      const value = await context.ui.text({
        message: `Confirmed license / permission basis for ${asset.id}`,
        ...(suggestedLicense ? { initialValue: suggestedLicense } : { placeholder: 'unknown' }),
      });
      return value.trim().length > 0 ? value.trim() : undefined;
    },
    promptAllowInCorpus: async (asset) =>
      context.ui.confirm({
        message: `Allow ${asset.id} in corpus?`,
        initialValue: true,
      }),
    promptRejectReason: async (_asset) => {
      const choice = await context.ui.select<string>({
        message: 'Rejection reason',
        initialValue: 'license',
        options: [
          { value: 'license', label: 'License', hint: 'incompatible or unclear license' },
          { value: 'quality', label: 'Quality', hint: 'too low resolution or corrupted' },
          { value: 'irrelevant', label: 'Irrelevant', hint: 'not a QR image' },
          { value: 'duplicate', label: 'Duplicate', hint: 'already in corpus or staging' },
          { value: 'custom', label: 'Custom…' },
        ],
      });
      if (choice === 'custom') {
        return context.ui.text({ message: 'Custom rejection reason' });
      }
      return choice;
    },
    promptQrCount: async (_, initialValue) =>
      promptQrCount(context.ui, 'How many QR codes are present in this image?', initialValue),
    promptGroundTruth: async (_, qrCount, scanResult) => {
      const prefills = scanResult.succeeded
        ? scanResult.results.map((entry) => ({
            text: entry.text,
            ...(entry.kind ? { kind: entry.kind } : {}),
          }))
        : [];
      return promptManualGroundTruth(context.ui, qrCount, prefills);
    },
    scanAsset: async (asset) =>
      context.ui.spin(`Scanning ${asset.id}`, async () => {
        const imagePath = resolveStagedAssetPath(stageDir, asset.id, asset.imageFileName);
        return scanLocalImageFile(imagePath);
      }),
    openSourcePage: context.openExternal,
    log: (line) => context.ui.info(line),
  });

  context.ui.info(
    `Review complete: ${summary.approved} approved, ${summary.rejected} rejected, ${summary.skipped} skipped${summary.quitEarly ? ' (quit early)' : ''}`,
  );
  context.ui.info(`Next: ${buildFilteredCliCommand('import', [stageDir])}`);

  return {
    stageDir: path.resolve(stageDir),
    reviewer,
    summary,
  };
};
