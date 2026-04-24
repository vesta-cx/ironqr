import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AccuracyBenchmarkCacheSummary,
  AccuracyEngine,
  AccuracyScanResult,
  CorpusBenchAsset,
} from './types.js';

const CACHE_DIRECTORY = path.join('tools', 'bench', '.cache');
const DEFAULT_CACHE_FILE = path.join(CACHE_DIRECTORY, 'accuracy.json');
const CACHE_FILE_VERSION = 1;

interface CachedScanEntry {
  readonly assetId: string;
  readonly assetLabel: CorpusBenchAsset['label'];
  readonly assetSha256: string;
  readonly relativePath: string;
  readonly engineId: string;
  readonly engineVersion: string;
  readonly durationMs: number;
  readonly scan: AccuracyScanResult;
  readonly updatedAt: string;
}

interface CachedScanFile {
  readonly version: number;
  readonly updatedAt: string;
  readonly entries: Record<string, Record<string, CachedScanEntry>>;
}

export interface AccuracyCacheStore {
  isEnabledFor: (engine: AccuracyEngine) => boolean;
  read: (
    engine: AccuracyEngine,
    asset: Pick<CorpusBenchAsset, 'id' | 'label' | 'sha256' | 'relativePath'>,
  ) => { readonly scan: AccuracyScanResult; readonly durationMs: number } | null;
  write: (
    engine: AccuracyEngine,
    asset: Pick<CorpusBenchAsset, 'id' | 'label' | 'sha256' | 'relativePath'>,
    scan: AccuracyScanResult,
    durationMs: number,
  ) => Promise<void>;
  evict: (
    engine: AccuracyEngine,
    asset: Pick<CorpusBenchAsset, 'id' | 'label' | 'sha256' | 'relativePath'>,
  ) => Promise<void>;
  save: () => Promise<void>;
  summary: () => AccuracyBenchmarkCacheSummary;
}

const emptyCacheFile = (): CachedScanFile => ({
  version: CACHE_FILE_VERSION,
  updatedAt: new Date(0).toISOString(),
  entries: {},
});

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const isValidCacheFile = (value: unknown): value is CachedScanFile => {
  if (!isRecord(value)) return false;
  const candidate = value as Partial<CachedScanFile>;
  return candidate.version === CACHE_FILE_VERSION && isRecord(candidate.entries);
};

export const getDefaultAccuracyCachePath = (repoRoot: string): string => {
  return path.join(repoRoot, DEFAULT_CACHE_FILE);
};

export const openAccuracyCacheStore = async (
  file: string,
  options: {
    readonly enabled: boolean;
    readonly refresh: boolean;
    readonly disabledEngineIds?: readonly string[];
  },
): Promise<AccuracyCacheStore> => {
  const stats = {
    hits: 0,
    misses: 0,
    writes: 0,
  };

  if (!options.enabled) {
    return {
      isEnabledFor: () => false,
      read: () => null,
      write: async () => {},
      evict: async () => {},
      save: async () => {},
      summary: () => ({
        enabled: false,
        file: null,
        hits: stats.hits,
        misses: stats.misses,
        writes: stats.writes,
      }),
    } satisfies AccuracyCacheStore;
  }

  const disabledEngineIds = new Set(options.disabledEngineIds ?? []);
  let snapshot = emptyCacheFile();
  try {
    const raw = await readFile(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (isValidCacheFile(parsed)) {
      snapshot = parsed;
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      // Cache file does not exist yet.
    } else if (error instanceof SyntaxError) {
      snapshot = emptyCacheFile();
    } else {
      throw error;
    }
  }

  let dirty = false;
  let writeTail = Promise.resolve();

  const flushToDisk = async (): Promise<void> => {
    if (!dirty) return;
    const snapshotToWrite = snapshot;
    dirty = false;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(snapshotToWrite, null, 2)}\n`, 'utf8');
    if (snapshot !== snapshotToWrite) {
      dirty = true;
    }
  };

  const isEnabledFor = (engine: AccuracyEngine): boolean => {
    return engine.cache.enabled && !disabledEngineIds.has(engine.id);
  };

  return {
    isEnabledFor,
    read: (engine, asset) => {
      if (!isEnabledFor(engine)) return null;
      if (options.refresh) {
        stats.misses += 1;
        return null;
      }

      const entry = snapshot.entries[engine.id]?.[asset.id];
      if (!entry) {
        stats.misses += 1;
        return null;
      }
      if (
        entry.engineVersion !== engine.cache.version ||
        entry.assetSha256 !== asset.sha256 ||
        entry.assetLabel !== asset.label ||
        entry.relativePath !== asset.relativePath
      ) {
        stats.misses += 1;
        return null;
      }

      stats.hits += 1;
      return {
        scan: entry.scan,
        durationMs: entry.durationMs,
      };
    },
    write: async (engine, asset, scan, durationMs) => {
      if (!isEnabledFor(engine)) return;
      snapshot = {
        ...snapshot,
        updatedAt: new Date().toISOString(),
        entries: {
          ...snapshot.entries,
          [engine.id]: {
            ...(snapshot.entries[engine.id] ?? {}),
            [asset.id]: {
              assetId: asset.id,
              assetLabel: asset.label,
              assetSha256: asset.sha256,
              relativePath: asset.relativePath,
              engineId: engine.id,
              engineVersion: engine.cache.version,
              durationMs,
              scan,
              updatedAt: new Date().toISOString(),
            },
          },
        },
      };
      dirty = true;
      stats.writes += 1;
      writeTail = writeTail.then(flushToDisk, flushToDisk);
      await writeTail;
    },
    evict: async (engine, asset) => {
      if (!isEnabledFor(engine)) return;
      const engineEntries = snapshot.entries[engine.id];
      if (!engineEntries?.[asset.id]) return;
      const { [asset.id]: _removed, ...remaining } = engineEntries;
      snapshot = {
        ...snapshot,
        updatedAt: new Date().toISOString(),
        entries: {
          ...snapshot.entries,
          [engine.id]: remaining,
        },
      };
      dirty = true;
      writeTail = writeTail.then(flushToDisk, flushToDisk);
      await writeTail;
    },
    save: async () => {
      await writeTail;
      await flushToDisk();
    },
    summary: () => ({
      enabled: true,
      file,
      hits: stats.hits,
      misses: stats.misses,
      writes: stats.writes,
    }),
  } satisfies AccuracyCacheStore;
};
