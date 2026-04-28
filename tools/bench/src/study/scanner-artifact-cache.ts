import crypto from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type ScannerArtifactLayer =
  | 'normalizedFrame'
  | 'scalarViews'
  | 'binaryViews'
  | 'finderEvidence'
  | 'proposalBatches'
  | 'rankedFrontier'
  | 'clusterFrontier'
  | 'decodeOutcome';

/**
 * Scanner artifact cache schema/semantic versions.
 *
 * Bump a layer when changing code that affects that layer's artifact bytes,
 * artifact meaning, or downstream behavior derived from that artifact.
 *
 * Downstream layer keys include upstream keys, so bumping an upstream layer
 * automatically invalidates downstream artifacts.
 */
export const ARTIFACT_LAYER_VERSIONS = {
  /**
   * Bump when normalized frame dimensions, color conversion, alpha handling,
   * input image normalization, or serialized frame layout changes.
   */
  normalizedFrame: 1,
  /**
   * Bump when scalar view formulas, scalar view ids, channel transforms,
   * or serialized scalar-view layout changes.
   */
  scalarViews: 1,
  /**
   * Bump when threshold algorithms, binary polarity handling, binary view ids,
   * or serialized binary-view layout changes.
   */
  binaryViews: 1,
  /**
   * Bump when row-scan/matcher/flood detector behavior, detector policy
   * interpretation, finder evidence scoring, dedupe, or finder serialization changes.
   */
  finderEvidence: 1,
  /**
   * Bump when finder triple assembly, proposal construction, proposal caps,
   * geometry variant semantics, or proposal serialization changes.
   */
  proposalBatches: 1,
  /**
   * Bump when proposal ranking formulas, score breakdown semantics,
   * geometry candidate creation used during ranking, or ranked-frontier
   * serialization/rehydration changes.
   */
  rankedFrontier: 1,
  /**
   * Bump when cluster keying, cluster scoring, representative ordering,
   * representative budgets, or cluster serialization changes.
   */
  clusterFrontier: 1,
  /**
   * Bump when decode cascade behavior, samplers, decode-neighborhood policy,
   * structural failure policy, max-attempt semantics, trace summary semantics,
   * or decode outcome serialization changes.
   */
  decodeOutcome: 1,
} as const satisfies Readonly<Record<ScannerArtifactLayer, number>>;

const LAYER_DIRECTORIES = {
  normalizedFrame: 'L1-normalized-frame',
  scalarViews: 'L2-scalar-views',
  binaryViews: 'L3-binary-views',
  finderEvidence: 'L4-finder-evidence',
  proposalBatches: 'L5-proposal-batches',
  rankedFrontier: 'L6-ranked-frontier',
  clusterFrontier: 'L7-cluster-frontier',
  decodeOutcome: 'L8-decode-outcome',
} as const satisfies Readonly<Record<ScannerArtifactLayer, string>>;

export interface ScannerArtifactCacheOptions {
  readonly enabled: boolean;
  readonly refresh: boolean;
  readonly directory: string;
}

export interface ScannerArtifactKeyInput {
  readonly layer: ScannerArtifactLayer;
  readonly assetId: string;
  readonly assetSha256: string;
  readonly upstreamKey?: string;
  readonly config?: unknown;
}

export interface ScannerArtifactEnvelope<T> {
  readonly layer: ScannerArtifactLayer;
  readonly version: number;
  readonly key: string;
  readonly assetId: string;
  readonly assetSha256: string;
  readonly upstreamKey: string | null;
  readonly createdAt: string;
  readonly value: T;
}

export interface ScannerArtifactLayerStats {
  readonly hits: number;
  readonly misses: number;
  readonly writes: number;
}

export interface ScannerArtifactCacheSummary {
  readonly enabled: boolean;
  readonly directory: string | null;
  readonly layers: Readonly<Record<ScannerArtifactLayer, ScannerArtifactLayerStats>>;
}

export interface ScannerArtifactCacheHandle {
  readonly key: (input: ScannerArtifactKeyInput) => string;
  readonly readJson: <T>(input: ScannerArtifactKeyInput) => Promise<T | null>;
  readonly writeJson: <T>(input: ScannerArtifactKeyInput, value: T) => Promise<string | null>;
  readonly readBinary: (input: ScannerArtifactKeyInput) => Promise<Uint8Array | null>;
  readonly writeBinary: (
    input: ScannerArtifactKeyInput,
    bytes: Uint8Array,
  ) => Promise<string | null>;
  readonly mergeSummary: (summary: ScannerArtifactCacheSummary) => void;
  readonly summary: () => ScannerArtifactCacheSummary;
}

export const openScannerArtifactCache = (
  options: ScannerArtifactCacheOptions,
): ScannerArtifactCacheHandle => {
  const mutableStats = Object.fromEntries(
    (Object.keys(ARTIFACT_LAYER_VERSIONS) as ScannerArtifactLayer[]).map((layer) => [
      layer,
      { hits: 0, misses: 0, writes: 0 },
    ]),
  ) as Record<ScannerArtifactLayer, { hits: number; misses: number; writes: number }>;

  const record = (layer: ScannerArtifactLayer, field: keyof ScannerArtifactLayerStats): void => {
    mutableStats[layer][field] += 1;
  };

  const key = (input: ScannerArtifactKeyInput): string => artifactKey(input);

  const readJson = async <T>(input: ScannerArtifactKeyInput): Promise<T | null> => {
    if (!options.enabled || options.refresh) {
      record(input.layer, 'misses');
      return null;
    }
    const artifactPath = jsonPath(options.directory, input, key(input));
    try {
      const envelope = JSON.parse(
        await readFile(artifactPath, 'utf8'),
      ) as ScannerArtifactEnvelope<T>;
      if (!validEnvelope(envelope, input, key(input))) {
        record(input.layer, 'misses');
        return null;
      }
      record(input.layer, 'hits');
      return envelope.value;
    } catch {
      record(input.layer, 'misses');
      return null;
    }
  };

  const writeJson = async <T>(input: ScannerArtifactKeyInput, value: T): Promise<string | null> => {
    if (!options.enabled) return null;
    const artifactKeyValue = key(input);
    const file = jsonPath(options.directory, input, artifactKeyValue);
    const envelope = {
      layer: input.layer,
      version: ARTIFACT_LAYER_VERSIONS[input.layer],
      key: artifactKeyValue,
      assetId: input.assetId,
      assetSha256: input.assetSha256,
      upstreamKey: input.upstreamKey ?? null,
      createdAt: new Date().toISOString(),
      value,
    } satisfies ScannerArtifactEnvelope<T>;
    await writeAtomic(file, `${JSON.stringify(envelope)}\n`, 'utf8');
    record(input.layer, 'writes');
    return artifactKeyValue;
  };

  const readBinary = async (input: ScannerArtifactKeyInput): Promise<Uint8Array | null> => {
    if (!options.enabled || options.refresh) {
      record(input.layer, 'misses');
      return null;
    }
    try {
      const bytes = await readFile(binaryPath(options.directory, input, key(input)));
      record(input.layer, 'hits');
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    } catch {
      record(input.layer, 'misses');
      return null;
    }
  };

  const writeBinary = async (
    input: ScannerArtifactKeyInput,
    bytes: Uint8Array,
  ): Promise<string | null> => {
    if (!options.enabled) return null;
    const artifactKeyValue = key(input);
    await writeAtomic(binaryPath(options.directory, input, artifactKeyValue), bytes);
    record(input.layer, 'writes');
    return artifactKeyValue;
  };

  return {
    key,
    readJson,
    writeJson,
    readBinary,
    writeBinary,
    mergeSummary(summary) {
      for (const layer of Object.keys(mutableStats) as ScannerArtifactLayer[]) {
        const next = summary.layers[layer];
        mutableStats[layer].hits += next.hits;
        mutableStats[layer].misses += next.misses;
        mutableStats[layer].writes += next.writes;
      }
    },
    summary() {
      return {
        enabled: options.enabled,
        directory: options.enabled ? options.directory : null,
        layers: Object.fromEntries(
          (Object.keys(mutableStats) as ScannerArtifactLayer[]).map((layer) => [
            layer,
            { ...mutableStats[layer] },
          ]),
        ) as Readonly<Record<ScannerArtifactLayer, ScannerArtifactLayerStats>>,
      };
    },
  };
};

const artifactKey = (input: ScannerArtifactKeyInput): string =>
  crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        layer: input.layer,
        version: ARTIFACT_LAYER_VERSIONS[input.layer],
        assetId: input.assetId,
        assetSha256: input.assetSha256,
        upstreamKey: input.upstreamKey ?? null,
        config: input.config ?? null,
      }),
    )
    .digest('hex');

const validEnvelope = <T>(
  envelope: ScannerArtifactEnvelope<T>,
  input: ScannerArtifactKeyInput,
  key: string,
): boolean =>
  envelope.layer === input.layer &&
  envelope.version === ARTIFACT_LAYER_VERSIONS[input.layer] &&
  envelope.key === key &&
  envelope.assetId === input.assetId &&
  envelope.assetSha256 === input.assetSha256 &&
  envelope.upstreamKey === (input.upstreamKey ?? null);

const jsonPath = (root: string, input: ScannerArtifactKeyInput, key: string): string =>
  artifactPath(root, input, key, 'json');

const binaryPath = (root: string, input: ScannerArtifactKeyInput, key: string): string =>
  artifactPath(root, input, key, 'bin');

const artifactPath = (
  root: string,
  input: ScannerArtifactKeyInput,
  key: string,
  extension: 'json' | 'bin',
): string =>
  path.join(
    root,
    LAYER_DIRECTORIES[input.layer],
    input.assetId,
    key.slice(0, 2),
    `${key}.${extension}`,
  );

const writeAtomic = async (
  file: string,
  data: string | Uint8Array,
  encoding?: BufferEncoding,
): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, data, encoding === undefined ? undefined : { encoding });
  await rename(temporary, file);
};
