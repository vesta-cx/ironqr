import path from 'node:path';
import {
  buildRealWorldBenchmarkCorpus,
  writeRealWorldBenchmarkCorpus,
} from './export/benchmark.js';
import { importLocalAssets } from './import/local.js';
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
  bun run corpus/cli.ts export-benchmark`);
}

await main();
