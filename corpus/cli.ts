import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline/promises';
import {
  buildRealWorldBenchmarkCorpus,
  writeRealWorldBenchmarkCorpus,
} from './export/benchmark.js';
import { importLocalAssets } from './import/local.js';
import { importStagedRemoteAssets, scrapeRemoteAssets } from './import/remote.js';
import { reviewStagedAssets } from './review.js';
import { scanLocalImageFile } from './scan.js';
import type { CorpusAssetLabel, ReviewStatus } from './schema.js';

function getOption(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function getPositionals(): string[] {
  const values: string[] = [];

  for (let index = 2; index < process.argv.length; index += 1) {
    const value = process.argv[index];
    if (!value) continue;
    if (value.startsWith('--')) {
      index += 1;
      continue;
    }
    values.push(value);
  }

  return values;
}

function parseLabel(value: string | undefined): CorpusAssetLabel {
  if (value === 'qr-positive' || value === 'non-qr-negative') {
    return value;
  }

  throw new Error('Expected --label qr-positive|non-qr-negative');
}

function parseReviewStatus(value: string | undefined): ReviewStatus | undefined {
  if (!value) return undefined;
  if (value === 'pending' || value === 'approved' || value === 'rejected') {
    return value;
  }

  throw new Error('Expected --review pending|approved|rejected');
}

function parseLimit(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('Expected --limit to be a positive number');
  }
  return parsed;
}

function detectGithubLogin(): string | undefined {
  try {
    const login = execFileSync('gh', ['api', 'user', '--jq', '.login'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return login || undefined;
  } catch {
    return undefined;
  }
}

async function resolveReviewer(
  prompt: (message: string) => Promise<string>,
  explicitReviewer?: string,
): Promise<string> {
  if (explicitReviewer) {
    return explicitReviewer;
  }

  const detected = detectGithubLogin();
  const answer = await prompt(
    detected ? `Reviewer GitHub username [default: ${detected}]:` : 'Reviewer GitHub username:',
  );
  return answer || detected || '';
}

function openTarget(target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child =
      process.platform === 'darwin'
        ? spawn('open', [target], { stdio: 'ignore', detached: true })
        : process.platform === 'win32'
          ? spawn('cmd', ['/c', 'start', '', target], { stdio: 'ignore', detached: true })
          : spawn('xdg-open', [target], { stdio: 'ignore', detached: true });

    child.on('error', reject);
    child.unref();
    resolve();
  });
}

async function main(): Promise<void> {
  const [command, ...rest] = getPositionals();
  const repoRoot = process.cwd();

  if (command === 'import-local') {
    const reviewStatus = parseReviewStatus(getOption('review'));
    const reviewer = getOption('reviewer');
    const reviewNotes = getOption('review-notes');
    const attribution = getOption('attribution');
    const license = getOption('license');
    const provenanceNotes = getOption('notes');

    const result = await importLocalAssets({
      repoRoot,
      paths: rest.map((value) => path.resolve(value)),
      label: parseLabel(getOption('label')),
      ...(reviewStatus ? { reviewStatus } : {}),
      ...(reviewer ? { reviewer } : {}),
      ...(reviewNotes ? { reviewNotes } : {}),
      ...(attribution ? { attribution } : {}),
      ...(license ? { license } : {}),
      ...(provenanceNotes ? { provenanceNotes } : {}),
    });

    console.log(
      `Imported ${result.imported.length}, deduped ${result.deduped.length}, total ${result.manifest.assets.length}`,
    );
    return;
  }

  if (command === 'scrape-remote') {
    const limit = parseLimit(getOption('limit'));
    const result = await scrapeRemoteAssets({
      repoRoot,
      seedUrls: rest,
      label: parseLabel(getOption('label')),
      ...(limit ? { limit } : {}),
    });

    console.log(`Staged ${result.assets.length} images in ${result.stageDir}`);
    console.log(`Review them, then import with:`);
    console.log(`  bun run corpus/cli.ts import-staged ${result.stageDir}`);
    return;
  }

  if (command === 'review-staged') {
    const reviewerOption = getOption('reviewer');
    const stageDir = rest[0];

    if (!stageDir) {
      throw new Error(
        'Expected a stage directory: bun run corpus/cli.ts review-staged corpus/staging/<run-id>',
      );
    }

    const resolvedStageDir = path.resolve(stageDir);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const prompt = async (message: string): Promise<string> => rl.question(`${message} `);

    try {
      const reviewer = await resolveReviewer(prompt, reviewerOption);
      if (!reviewer) {
        throw new Error('Reviewer GitHub username is required for review');
      }

      const summary = await reviewStagedAssets({
        stageDir: resolvedStageDir,
        reviewer,
        prompt,
        scanAsset: async (asset) => {
          const imagePath = path.resolve(resolvedStageDir, asset.id, asset.imageFileName);
          if (imagePath !== path.join(resolvedStageDir, asset.id, asset.imageFileName)) {
            throw new Error(`Scan path escapes stage directory: ${imagePath}`);
          }
          return scanLocalImageFile(imagePath);
        },
        openLocalImage: openTarget,
        openSourcePage: openTarget,
        log: (line) => console.log(line),
      });

      console.log(
        `Review complete: ${summary.approved} approved, ${summary.rejected} rejected, ${summary.skipped} skipped${summary.quitEarly ? ' (quit early)' : ''}`,
      );
      console.log(`Next step:`);
      console.log(`  bun run corpus/cli.ts import-staged ${resolvedStageDir}`);
    } finally {
      rl.close();
    }

    return;
  }

  if (command === 'import-staged') {
    const reviewStatus = parseReviewStatus(getOption('review'));
    const reviewer = getOption('reviewer');
    const reviewNotes = getOption('review-notes');
    const attribution = getOption('attribution');
    const license = getOption('license');
    const provenanceNotes = getOption('notes');
    const overrideLabel = getOption('label');
    const stageDir = rest[0];

    if (!stageDir) {
      throw new Error(
        'Expected a stage directory: bun run corpus/cli.ts import-staged corpus/staging/<run-id>',
      );
    }

    const result = await importStagedRemoteAssets({
      repoRoot,
      stageDir: path.resolve(stageDir),
      ...(reviewStatus ? { reviewStatus } : {}),
      ...(reviewer ? { reviewer } : {}),
      ...(reviewNotes ? { reviewNotes } : {}),
      ...(overrideLabel ? { overrideLabel: parseLabel(overrideLabel) } : {}),
      ...(attribution ? { attribution } : {}),
      ...(license ? { license } : {}),
      ...(provenanceNotes ? { provenanceNotes } : {}),
    });

    console.log(
      `Imported ${result.imported.length}, deduped ${result.deduped.length}, total ${result.manifest.assets.length}`,
    );
    return;
  }

  if (command === 'export-benchmark') {
    const outputPath = await writeRealWorldBenchmarkCorpus(repoRoot);
    const corpus = await buildRealWorldBenchmarkCorpus(repoRoot);
    console.log(
      `Wrote ${outputPath} (${corpus.positives.length} positives, ${corpus.negatives.length} negatives)`,
    );
    return;
  }

  console.log(`Usage:
  bun run corpus/cli.ts import-local --label qr-positive|non-qr-negative [--review pending|approved|rejected] <files...>
  bun run corpus/cli.ts scrape-remote --label qr-positive|non-qr-negative [--limit 25] <seed-urls...>
  bun run corpus/cli.ts review-staged <stage-dir> [--reviewer github-login]
  bun run corpus/cli.ts import-staged <stage-dir> [--label qr-positive|non-qr-negative] [--review pending|approved|rejected]
  bun run corpus/cli.ts export-benchmark`);
}

await main();
