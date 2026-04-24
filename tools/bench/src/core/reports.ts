import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { CorpusAssetLabel } from '../accuracy/types.js';

export type BenchReportStatus = 'passed' | 'failed' | 'errored' | 'interrupted';
export type BenchmarkVerdictStatus = 'passed' | 'failed' | 'unavailable';

export interface BenchmarkVerdict {
  readonly status: BenchmarkVerdictStatus;
  readonly description: string;
}

export interface EngineRunDescriptor {
  readonly id: string;
  readonly adapterVersion: string;
  readonly packageName?: string;
  readonly packageVersion?: string;
  readonly runtimeVersion?: string;
}

export interface BenchReportEnvelope<Kind extends string, Summary extends object, Details> {
  readonly kind: Kind;
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly status: BenchReportStatus;
  readonly verdicts: {
    readonly pass: BenchmarkVerdict;
    readonly regression: BenchmarkVerdict;
  };
  readonly benchmark: {
    readonly name: string;
    readonly description: string;
  };
  readonly command: {
    readonly name: 'suite' | 'accuracy' | 'performance' | 'study';
    readonly argv: readonly string[];
  };
  readonly repo: {
    readonly root: string;
    readonly commit: string | null;
    readonly dirty: boolean | null;
  };
  readonly corpus: {
    readonly manifestPath: string;
    readonly assetCount: number;
    readonly positiveCount: number;
    readonly negativeCount: number;
    readonly manifestHash: string;
    readonly assetIds: readonly string[];
  };
  readonly selection: {
    readonly seed: string | null;
    readonly filters: Record<string, unknown>;
  };
  readonly engines: readonly EngineRunDescriptor[];
  readonly options: Record<string, unknown>;
  readonly summary: Summary;
  readonly details: Details;
}

export interface ReportCorpusInput {
  readonly repoRoot: string;
  readonly assets: readonly {
    readonly assetId: string;
    readonly label: CorpusAssetLabel;
  }[];
}

export const REPORT_SCHEMA_VERSION = 1;
const execFileAsync = promisify(execFile);

export const buildReportCorpus = async ({ repoRoot, assets }: ReportCorpusInput) => {
  const manifestPath = path.join(repoRoot, 'corpus', 'data', 'manifest.json');
  const manifest = await readFile(manifestPath, 'utf8');
  return {
    manifestPath,
    assetCount: assets.length,
    positiveCount: assets.filter((asset) => asset.label === 'qr-pos').length,
    negativeCount: assets.filter((asset) => asset.label === 'qr-neg').length,
    manifestHash: createHash('sha256').update(manifest).digest('hex'),
    assetIds: assets.map((asset) => asset.assetId),
  };
};

export const unavailableVerdict = (description: string): BenchmarkVerdict => ({
  status: 'unavailable',
  description,
});

export const passedVerdict = (description: string): BenchmarkVerdict => ({
  status: 'passed',
  description,
});

export const failedVerdict = (description: string): BenchmarkVerdict => ({
  status: 'failed',
  description,
});

export const readRepoMetadata = async (repoRoot: string) => {
  try {
    const [{ stdout: commit }, dirtyResult] = await Promise.all([
      execFileAsync('git', ['-C', repoRoot, 'rev-parse', 'HEAD']),
      execFileAsync('git', ['-C', repoRoot, 'status', '--porcelain']),
    ]);
    return {
      root: repoRoot,
      commit: commit.trim() || null,
      dirty: dirtyResult.stdout.trim().length > 0,
    };
  } catch {
    return { root: repoRoot, commit: null, dirty: null };
  }
};

export const writeJsonReport = async (filePath: string, report: unknown): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
};

export const writeReportWithSnapshot = async (
  latestPath: string,
  report: { readonly generatedAt?: string; readonly repo?: { readonly commit: string | null } },
): Promise<void> => {
  await writeJsonReport(latestPath, report);
  const reportsRoot = path.dirname(latestPath);
  const timestamp = sanitizePathPart(report.generatedAt ?? new Date().toISOString());
  const shortSha = report.repo?.commit ? report.repo.commit.slice(0, 7) : 'no-git';
  const snapshotPath = path.join(
    reportsRoot,
    'runs',
    `${timestamp}-${shortSha}`,
    path.basename(latestPath),
  );
  await writeJsonReport(snapshotPath, report);
};

const sanitizePathPart = (value: string): string => value.replace(/[^a-zA-Z0-9._-]+/g, '-');
