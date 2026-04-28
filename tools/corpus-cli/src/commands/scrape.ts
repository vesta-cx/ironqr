import path from 'node:path';
import { getOption, type ParsedArgs } from '../args.js';
import { buildFilteredCliCommand } from '../command-text.js';
import type { AppContext } from '../context.js';
import { type ScrapeRemoteAssetsResult, scrapeRemoteAssets } from '../import/remote.js';
import { isInteractiveSession } from '../tty.js';
import { DEFAULT_FETCH_DELAY_MS, resolveSeedUrls, resolveStageLimit } from './shared.js';

interface ScrapeInputs {
  readonly seedUrls: readonly string[];
  readonly limit?: number;
}

/** Resolve seed URLs and optional limit from args or interactive prompts. */
export const resolveScrapeInputs = async (
  context: AppContext,
  args: ParsedArgs,
): Promise<ScrapeInputs> => {
  const seedUrls = await resolveSeedUrls(context, args);

  const limitOption = getOption(args, 'limit');
  let limit: number | undefined;
  if (limitOption || isInteractiveSession()) {
    limit = await resolveStageLimit(context, args);
  }

  return { seedUrls, ...(limit ? { limit } : {}) };
};

/** Run the `scrape` command: fetch remote images into a new staging directory. */
export const runScrapeCommand = async (
  context: AppContext,
  args: ParsedArgs,
): Promise<ScrapeRemoteAssetsResult> => {
  const inputs = await resolveScrapeInputs(context, args);
  const runScrape = () =>
    scrapeRemoteAssets({
      repoRoot: context.repoRoot,
      seedUrls: inputs.seedUrls,
      label: 'qr-pos',
      ...(inputs.limit ? { limit: inputs.limit } : {}),
      fetchDelayMs: DEFAULT_FETCH_DELAY_MS,
      log: (line) => {
        if (context.ui.verbose) {
          context.ui.debug(line);
        }
      },
    });

  const result = context.ui.verbose
    ? await runScrape()
    : await context.ui.spin('Scraping remote assets', runScrape);

  context.ui.info(
    `Staged ${result.assets.length} image(s) in ${path.relative(context.repoRoot, result.stageDir)}`,
  );
  if (result.assets.length > 0) {
    context.ui.info(`Next: ${buildFilteredCliCommand('review', [result.stageDir])}`);
  }
  return result;
};
