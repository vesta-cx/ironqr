import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { writeRealWorldBenchmarkCorpus } from './export/benchmark.js';
import { importLocalAssets } from './import/local.js';
import {
  importStagedRemoteAssets,
  resolveStagedAssetPath,
  scrapeRemoteAssets,
} from './import/remote.js';
import { reviewStagedAssets } from './review.js';
import { scanLocalImageFile } from './scan.js';
import type { CorpusAssetLabel, ReviewStatus } from './schema.js';

const getOption = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  return process.argv[index + 1];
};

const getPositionals = (): string[] => {
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
};

const parseLabel = (value: string | undefined): CorpusAssetLabel => {
  if (value === 'qr-positive' || value === 'non-qr-negative') {
    return value;
  }

  throw new Error('Expected --label qr-positive|non-qr-negative');
};

const parseReviewStatus = (value: string | undefined): ReviewStatus | undefined => {
  if (!value) return undefined;
  if (value === 'pending' || value === 'approved' || value === 'rejected') {
    return value;
  }

  throw new Error('Expected --review pending|approved|rejected');
};

const parseLimit = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('Expected --limit to be a positive number');
  }
  return parsed;
};

const detectGithubLogin = (): string | undefined => {
  try {
    const login = execFileSync('gh', ['api', 'user', '--jq', '.login'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return login || undefined;
  } catch {
    return undefined;
  }
};

const resolveReviewer = async (
  prompt: (message: string) => Promise<string>,
  explicitReviewer?: string,
): Promise<string> => {
  if (explicitReviewer) {
    return explicitReviewer;
  }

  const detected = detectGithubLogin();
  const answer = await prompt(
    detected ? `Reviewer GitHub username [default: ${detected}]:` : 'Reviewer GitHub username:',
  );
  return answer || detected || '';
};

type OpenTargetInvocation = {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: {
    readonly stdio: 'ignore';
    readonly detached: true;
    readonly windowsVerbatimArguments?: true;
  };
};

export const buildOpenTargetInvocation = (
  target: string,
  platform: NodeJS.Platform = process.platform,
): OpenTargetInvocation => {
  const options = { stdio: 'ignore' as const, detached: true as const };

  if (platform === 'darwin') {
    return {
      command: 'open',
      args: [target],
      options,
    };
  }

  if (platform === 'win32') {
    return {
      command: 'cmd',
      args: ['/d', '/s', '/c', 'start', '""', `"${target}"`],
      options: {
        ...options,
        windowsVerbatimArguments: true,
      },
    };
  }

  return {
    command: 'xdg-open',
    args: [target],
    options,
  };
};

export const resolveRepoRootFromModuleUrl = (
  moduleUrl: string,
  override = process.env.IRONQR_REPO_ROOT,
): string => {
  if (override) {
    return path.resolve(override);
  }

  const sourceDirectory = fileURLToPath(new URL('.', moduleUrl));
  return path.resolve(sourceDirectory, '../../..');
};

export const buildFilteredCliCommand = (command: string, args: readonly string[] = []): string => {
  const renderedArgs = args.map((value) => JSON.stringify(value)).join(' ');
  return renderedArgs.length > 0
    ? `bun --filter ironqr-corpus-cli run cli -- ${command} ${renderedArgs}`
    : `bun --filter ironqr-corpus-cli run cli -- ${command}`;
};

export const getUsageText = (): string => {
  return `Usage:
  bun --filter ironqr-corpus-cli run cli -- import-local --label qr-positive|non-qr-negative [--review pending|approved|rejected] <files...>
  bun --filter ironqr-corpus-cli run cli -- scrape-remote --label qr-positive|non-qr-negative [--limit 25] <seed-urls...>
  bun --filter ironqr-corpus-cli run cli -- review-staged <stage-dir> [--reviewer github-login]
  bun --filter ironqr-corpus-cli run cli -- import-staged <stage-dir> [--label qr-positive|non-qr-negative] [--review pending|approved|rejected]
  bun --filter ironqr-corpus-cli run cli -- export-benchmark`;
};

const openTarget = (target: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    const { command, args, options } = buildOpenTargetInvocation(target);
    const child = spawn(command, args, options);

    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
};

const main = async (): Promise<void> => {
  const [command, ...rest] = getPositionals();
  const repoRoot = resolveRepoRootFromModuleUrl(import.meta.url);

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
    console.log(`  ${buildFilteredCliCommand('import-staged', [result.stageDir])}`);
    return;
  }

  if (command === 'review-staged') {
    const reviewerOption = getOption('reviewer');
    const stageDir = rest[0];

    if (!stageDir) {
      throw new Error(
        `Expected a stage directory: ${buildFilteredCliCommand('review-staged', ['corpus/staging/<run-id>'])}`,
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
          const imagePath = resolveStagedAssetPath(resolvedStageDir, asset.id, asset.imageFileName);
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
      console.log(`  ${buildFilteredCliCommand('import-staged', [resolvedStageDir])}`);
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
        `Expected a stage directory: ${buildFilteredCliCommand('import-staged', ['corpus/staging/<run-id>'])}`,
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
    const { outputPath, corpus } = await writeRealWorldBenchmarkCorpus(repoRoot);
    console.log(
      `Wrote ${outputPath} (${corpus.positives.length} positives, ${corpus.negatives.length} negatives)`,
    );
    return;
  }

  console.log(getUsageText());
};

if (import.meta.main) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
