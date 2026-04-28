import path from 'node:path';
import type { ParsedArgs } from '../args.js';
import type { AppContext } from '../context.js';
import { readStagedRemoteAssets, startScrapeRemoteAssets } from '../import/remote.js';
import { runBuildBenchCommand } from './build-bench.js';
import { runImportCommand } from './import.js';
import { runReviewCommand } from './review.js';

const withNoPositionals = (args: ParsedArgs): ParsedArgs => ({ ...args, positionals: [] });

import {
  DEFAULT_FETCH_DELAY_MS,
  listStageDirectories,
  resolveReviewer,
  resolveSeedUrls,
  resolveStageLimit,
} from './shared.js';

const listUnreviewedStageDirs = async (repoRoot: string): Promise<readonly string[]> => {
  const stageDirs = await listStageDirectories(repoRoot);
  const unreviewed: string[] = [];

  const results = await Promise.all(
    stageDirs.map(async (stageDir) => ({
      stageDir,
      assets: await readStagedRemoteAssets(stageDir),
    })),
  );
  for (const { stageDir, assets } of results) {
    if (assets.some((asset) => !asset.importedAssetId && asset.review.status === 'pending')) {
      unreviewed.push(stageDir);
    }
  }

  return unreviewed;
};

const promptUnreviewedStageDir = async (
  context: AppContext,
  stageDirs: readonly string[],
): Promise<string> => {
  if (stageDirs.length === 1) {
    return stageDirs[0]!;
  }

  return context.ui.select({
    message: 'Choose staged run to resume',
    options: stageDirs.map((stageDir) => ({
      value: stageDir,
      label: path.relative(context.repoRoot, stageDir),
    })),
  });
};

const runReviewImportRoundForExistingStageDir = async (
  context: AppContext,
  args: ParsedArgs,
  stageDir: string,
  reviewer: string,
): Promise<void> => {
  const review = await runReviewCommand(context, withNoPositionals(args), stageDir, reviewer);
  if (review.summary.approved > 0) {
    await runImportCommand(context, withNoPositionals(args), stageDir);
  }
};

const runStreamingRound = async (
  context: AppContext,
  args: ParsedArgs,
  seedUrls: readonly string[],
  limit: number,
  reviewer: string,
): Promise<{ readonly staged: number }> => {
  const session = await startScrapeRemoteAssets({
    repoRoot: context.repoRoot,
    seedUrls,
    label: 'qr-pos',
    limit,
    fetchDelayMs: DEFAULT_FETCH_DELAY_MS,
    log: (line) => {
      if (context.ui.verbose) {
        context.ui.debug(line);
      }
    },
  });

  context.ui.info(
    `Scraping into ${path.relative(context.repoRoot, session.stageDir)} — review starts as soon as first image lands`,
  );

  let reviewError: unknown;
  try {
    const review = await runReviewCommand(
      context,
      withNoPositionals(args),
      session.stageDir,
      reviewer,
      session.assets,
    );

    if (review.summary.approved > 0) {
      await runImportCommand(context, withNoPositionals(args), session.stageDir);
    }
  } catch (error) {
    reviewError = error;
  }

  const staged = await session.done.catch((doneError: unknown) => {
    if (reviewError) {
      throw new AggregateError([reviewError, doneError], 'Scrape and review both failed');
    }
    throw doneError;
  });

  if (reviewError) {
    throw reviewError;
  }

  return { staged: staged.length };
};

/**
 * Run the guided default flow: optionally resume unreviewed staged runs, then scrape → review → import in a loop.
 * Ends by offering to curate the perfbench fixture.
 */
export const runDefaultFlow = async (context: AppContext, args: ParsedArgs): Promise<void> => {
  const reviewer = await resolveReviewer(context);

  const unreviewedStageDirs = await listUnreviewedStageDirs(context.repoRoot);
  if (unreviewedStageDirs.length > 0) {
    const resume = await context.ui.confirm({
      message: 'Found unreviewed staged images from earlier run. Review those first?',
      initialValue: true,
    });

    if (resume) {
      const stageDir = await promptUnreviewedStageDir(context, unreviewedStageDirs);
      await runReviewImportRoundForExistingStageDir(context, args, stageDir, reviewer);
    }
  }

  const seedUrls = await resolveSeedUrls(context, args);

  while (true) {
    const limit = await resolveStageLimit(context, args);
    const { staged } = await runStreamingRound(context, args, seedUrls, limit, reviewer);

    if (staged === 0) {
      context.ui.outro('No images staged this round');
      return;
    }

    const continueScraping = await context.ui.confirm({
      message: 'Scrape another round?',
      initialValue: true,
    });
    if (continueScraping) {
      continue;
    }

    const shouldBuildBench = await context.ui.confirm({
      message: 'Curate committed perfbench fixture now?',
      initialValue: false,
    });
    if (shouldBuildBench) {
      await runBuildBenchCommand(context, withNoPositionals(args));
    }

    context.ui.outro('Corpus flow complete');
    return;
  }
};
