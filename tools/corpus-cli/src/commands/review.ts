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

const REJECTION_REASONS = {
  LICENSE: 'license',
  QUALITY: 'quality',
  IRRELEVANT: 'irrelevant',
  DUPLICATE: 'duplicate',
  CUSTOM: 'custom',
} as const;

interface ReviewCommandResult {
  readonly stageDir: string;
  readonly reviewer: string;
  readonly summary: ReviewSummary;
}

/**
 * Run the `review` command: walk staged assets and collect reviewer decisions.
 * Explicit overrides bypass interactive prompts for stage dir, reviewer, and asset stream.
 */
export const runReviewCommand = async (
  context: AppContext,
  args: ParsedArgs,
  explicitStageDir?: string,
  explicitReviewer?: string,
  explicitAssets?: AsyncIterable<StagedRemoteAsset>,
): Promise<ReviewCommandResult> => {
  const stageDir = await promptStageDir(context, explicitStageDir ?? args.positionals[0]);
  const reviewer = await resolveReviewer(context, explicitReviewer ?? getOption(args, 'reviewer'));

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
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    },
    promptAllowInCorpus: async (asset) =>
      context.ui.confirm({
        message: `Allow ${asset.id} in corpus?`,
        initialValue: true,
      }),
    promptRejectReason: async (_) => {
      const choice = await context.ui.select<string>({
        message: 'Rejection reason',
        initialValue: REJECTION_REASONS.LICENSE,
        options: [
          {
            value: REJECTION_REASONS.LICENSE,
            label: 'License',
            hint: 'incompatible or unclear license',
          },
          {
            value: REJECTION_REASONS.QUALITY,
            label: 'Quality',
            hint: 'too low resolution or corrupted',
          },
          { value: REJECTION_REASONS.IRRELEVANT, label: 'Irrelevant', hint: 'not a QR image' },
          {
            value: REJECTION_REASONS.DUPLICATE,
            label: 'Duplicate',
            hint: 'already in corpus or staging',
          },
          { value: REJECTION_REASONS.CUSTOM, label: 'Custom…' },
        ],
      });
      if (choice === REJECTION_REASONS.CUSTOM) {
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
    `Review complete: ${summary.approved} approved, ${summary.rejected} rejected, ${summary.skipped} skipped`,
  );
  context.ui.info(`Next: ${buildFilteredCliCommand('import', [stageDir])}`);

  return {
    stageDir: path.resolve(stageDir),
    reviewer,
    summary,
  };
};
