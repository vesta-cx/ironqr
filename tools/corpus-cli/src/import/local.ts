import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Effect } from 'effect';
import { readCorpusManifest, writeCorpusManifest } from '../manifest.js';
import type {
  CorpusAsset,
  CorpusAssetLabel,
  CorpusManifest,
  GroundTruth,
  LicenseReview,
  LocalSource,
  ReviewStatus,
} from '../schema.js';

/** Options for importing one or more local image files into the corpus. */
export interface ImportLocalAssetOptions {
  readonly repoRoot: string;
  readonly paths: readonly string[];
  readonly label: CorpusAssetLabel;
  readonly reviewStatus?: ReviewStatus;
  readonly reviewer?: string;
  readonly reviewNotes?: string;
  readonly attribution?: string;
  readonly license?: string;
  readonly provenanceNotes?: string;
  readonly groundTruth?: GroundTruth;
  readonly licenseReview?: LicenseReview;
}

/** Result of a local-asset import batch, listing newly added and deduplicated assets. */
export interface ImportLocalAssetResult {
  readonly imported: readonly CorpusAsset[];
  readonly deduped: readonly CorpusAsset[];
  readonly manifest: CorpusManifest;
}

import { MAJOR_VERSION } from '../version.js';
import { importAssetBytesEffect, mediaTypeFromExtension } from './store.js';

/** Import local image files into the corpus manifest, deduplicating by source SHA-256. */
export const importLocalAssets = (
  options: ImportLocalAssetOptions,
): Promise<ImportLocalAssetResult> => {
  return Effect.runPromise(importLocalAssetsEffect(options));
};

const importLocalAssetsEffect = (
  options: ImportLocalAssetOptions,
): Effect.Effect<ImportLocalAssetResult, unknown> => {
  return Effect.gen(function* () {
    const manifest = yield* Effect.tryPromise(() => readCorpusManifest(options.repoRoot));
    const assets = [...manifest.assets];
    const imported: CorpusAsset[] = [];
    const deduped: CorpusAsset[] = [];

    for (const inputPath of options.paths) {
      const absolutePath = path.resolve(inputPath);
      const extension = path.extname(absolutePath).toLowerCase();
      const mediaType = mediaTypeFromExtension(extension);

      if (!mediaType) {
        throw new Error(`Unsupported file extension: ${extension || '<none>'}`);
      }

      const bytes = yield* Effect.tryPromise(() => readFile(absolutePath));
      const source = buildSourceRecord(absolutePath, options);
      const result = yield* importAssetBytesEffect({
        repoRoot: options.repoRoot,
        assets,
        bytes,
        sourcePathForExtension: absolutePath,
        label: options.label,
        provenance: source,
        ...(options.reviewStatus ? { reviewStatus: options.reviewStatus } : {}),
        ...(options.reviewer ? { reviewer: options.reviewer } : {}),
        ...(options.reviewNotes ? { reviewNotes: options.reviewNotes } : {}),
        ...(options.groundTruth ? { groundTruth: options.groundTruth } : {}),
        ...(options.licenseReview ? { licenseReview: options.licenseReview } : {}),
      });

      if (result.deduped) {
        deduped.push(result.asset);
      } else {
        imported.push(result.asset);
      }
    }

    const nextManifest = { version: MAJOR_VERSION, assets };
    yield* Effect.tryPromise(() => writeCorpusManifest(options.repoRoot, nextManifest));

    return {
      imported,
      deduped,
      manifest: nextManifest,
    };
  });
};

const buildSourceRecord = (sourcePath: string, options: ImportLocalAssetOptions): LocalSource => {
  return {
    kind: 'local',
    originalPath: sourcePath,
    importedAt: new Date().toISOString(),
    ...(options.attribution ? { attribution: options.attribution } : {}),
    ...(options.license ? { license: options.license } : {}),
    ...(options.provenanceNotes ? { notes: options.provenanceNotes } : {}),
  };
};
