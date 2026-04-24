import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PerformanceIterationResult } from './runner.js';

const CACHE_DIRECTORY = path.join('tools', 'bench', '.cache');
const DEFAULT_CACHE_FILE = path.join(CACHE_DIRECTORY, 'performance.json');
const CACHE_SCHEMA_VERSION = 1;

interface PerformanceCacheEntry {
  readonly schemaVersion: typeof CACHE_SCHEMA_VERSION;
  readonly engineId: string;
  readonly engineVersion: string;
  readonly assetId: string;
  readonly assetSha256: string;
  readonly iteration: number;
  readonly optionsKey: string;
  readonly result: PerformanceIterationResult;
}

interface PerformanceCacheFile {
  readonly schemaVersion: typeof CACHE_SCHEMA_VERSION;
  readonly entries: Record<string, PerformanceCacheEntry>;
}

export interface PerformanceCacheStore {
  readonly file: string;
  read: (key: PerformanceCacheKey) => PerformanceIterationResult | null;
  write: (key: PerformanceCacheKey, result: PerformanceIterationResult) => Promise<void>;
  summary: () => {
    readonly enabled: boolean;
    readonly file: string | null;
    readonly hits: number;
    readonly misses: number;
    readonly writes: number;
  };
  save: () => Promise<void>;
}

export interface PerformanceCacheKey {
  readonly engineId: string;
  readonly engineVersion: string;
  readonly assetId: string;
  readonly assetSha256: string;
  readonly iteration: number;
  readonly optionsKey: string;
}

export const getDefaultPerformanceCachePath = (repoRoot: string): string =>
  path.join(repoRoot, DEFAULT_CACHE_FILE);

export const performanceOptionsKey = (input: {
  readonly iterations: number;
  readonly seed: string | null;
  readonly filters: Record<string, unknown>;
}): string => JSON.stringify({ timingMetricVersion: 1, ...input });

export const openPerformanceCacheStore = async (
  file: string,
  options: {
    readonly enabled: boolean;
    readonly refresh: boolean;
    readonly refreshEngineId?: string;
  },
): Promise<PerformanceCacheStore> => {
  let snapshot = options.enabled && !options.refresh ? await readCacheFile(file) : emptyCacheFile();
  let hits = 0;
  let misses = 0;
  let writes = 0;

  if (options.refreshEngineId) {
    snapshot = {
      ...snapshot,
      entries: Object.fromEntries(
        Object.entries(snapshot.entries).filter(
          ([, entry]) => entry.engineId !== options.refreshEngineId,
        ),
      ),
    };
  }

  const persist = async (): Promise<void> => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  };

  return {
    file,
    read: (key) => {
      if (!options.enabled) return null;
      const entry = snapshot.entries[cacheEntryKey(key)];
      if (!entry || !matchesKey(entry, key)) {
        misses += 1;
        return null;
      }
      hits += 1;
      return { ...entry.result, cached: true };
    },
    write: async (key, result) => {
      if (!options.enabled) return;
      writes += 1;
      snapshot = {
        ...snapshot,
        entries: {
          ...snapshot.entries,
          [cacheEntryKey(key)]: {
            schemaVersion: CACHE_SCHEMA_VERSION,
            ...key,
            result: { ...result, cached: false },
          },
        },
      };
      await persist();
    },
    summary: () => ({
      enabled: options.enabled,
      file: options.enabled ? file : null,
      hits,
      misses,
      writes,
    }),
    save: persist,
  };
};

const emptyCacheFile = (): PerformanceCacheFile => ({
  schemaVersion: CACHE_SCHEMA_VERSION,
  entries: {},
});

const readCacheFile = async (file: string): Promise<PerformanceCacheFile> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (isPerformanceCacheFile(parsed)) return parsed;
  } catch {
    // Open a fresh cache when the file is absent or malformed.
  }
  return emptyCacheFile();
};

const isPerformanceCacheFile = (value: unknown): value is PerformanceCacheFile => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PerformanceCacheFile>;
  return (
    candidate.schemaVersion === CACHE_SCHEMA_VERSION &&
    !!candidate.entries &&
    typeof candidate.entries === 'object'
  );
};

const cacheEntryKey = (key: PerformanceCacheKey): string =>
  [
    key.engineId,
    key.engineVersion,
    key.assetId,
    key.assetSha256,
    key.iteration,
    key.optionsKey,
  ].join('\u001f');

const matchesKey = (entry: PerformanceCacheEntry, key: PerformanceCacheKey): boolean =>
  entry.engineId === key.engineId &&
  entry.engineVersion === key.engineVersion &&
  entry.assetId === key.assetId &&
  entry.assetSha256 === key.assetSha256 &&
  entry.iteration === key.iteration &&
  entry.optionsKey === key.optionsKey;
