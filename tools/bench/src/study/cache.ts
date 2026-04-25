import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CorpusBenchAsset } from '../accuracy/types.js';
import type { StudyCacheHandle } from './types.js';

interface StudyCacheEntry {
  readonly assetId: string;
  readonly assetSha256: string;
  readonly cacheKey: string;
  readonly result: unknown;
}

interface StudyCacheSnapshot {
  readonly version: 1;
  readonly entries: Record<string, StudyCacheEntry>;
}

export interface StudyCacheOptions {
  readonly enabled: boolean;
  readonly refresh: boolean;
  readonly file: string;
}

const STUDY_CACHE_FLUSH_INTERVAL_MS = 5_000;
const STUDY_CACHE_FLUSH_WRITE_THRESHOLD = 1_024;

export const openStudyCache = async <AssetResult>(
  options: StudyCacheOptions,
): Promise<StudyCacheHandle<AssetResult>> => {
  const entries = options.enabled
    ? await readSnapshot(options.file)
    : new Map<string, StudyCacheEntry>();
  let hits = 0;
  let misses = 0;
  let writes = 0;
  let invalidRows = 0;
  let purgedRows = 0;
  let saveCounter = 0;
  let dirtyWrites = 0;
  let dirty = false;
  let flushTimer: NodeJS.Timeout | null = null;
  let saveTail = Promise.resolve();

  const clearFlushTimer = (): void => {
    if (flushTimer === null) return;
    clearTimeout(flushTimer);
    flushTimer = null;
  };

  const persist = async (): Promise<void> => {
    const snapshot: StudyCacheSnapshot = {
      version: 1,
      entries: Object.fromEntries(entries),
    };
    await mkdir(path.dirname(options.file), { recursive: true });
    saveCounter += 1;
    const tempFile = `${options.file}.${process.pid}.${Date.now()}.${saveCounter}.tmp`;
    await writeFile(tempFile, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    await rename(tempFile, options.file);
  };

  const flushOnce = (): Promise<void> => {
    if (!options.enabled) return Promise.resolve();
    clearFlushTimer();
    if (!dirty) return saveTail;
    dirty = false;
    dirtyWrites = 0;
    saveTail = saveTail.then(persist);
    return saveTail;
  };

  const flush = async (): Promise<void> => {
    await flushOnce();
    while (dirty) await flushOnce();
  };

  const queueSave = (): void => {
    if (!options.enabled) return;
    dirty = true;
    dirtyWrites += 1;
    if (dirtyWrites >= STUDY_CACHE_FLUSH_WRITE_THRESHOLD) {
      void flushOnce();
      return;
    }
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      void flushOnce();
    }, STUDY_CACHE_FLUSH_INTERVAL_MS);
    flushTimer.unref?.();
  };

  return {
    has(asset, cacheKey) {
      if (!options.enabled || options.refresh) return false;
      const entry = entries.get(entryKey(asset, cacheKey));
      return entry?.assetSha256 === asset.sha256 && entry.cacheKey === cacheKey;
    },
    async read(asset, cacheKey) {
      if (!options.enabled || options.refresh) {
        misses += 1;
        return null;
      }
      const key = entryKey(asset, cacheKey);
      const entry = entries.get(key);
      if (!entry) {
        misses += 1;
        return null;
      }
      if (entry.assetSha256 !== asset.sha256 || entry.cacheKey !== cacheKey) {
        entries.delete(key);
        invalidRows += 1;
        misses += 1;
        queueSave();
        return null;
      }
      hits += 1;
      return entry.result as AssetResult;
    },
    async write(asset, cacheKey, result) {
      if (!options.enabled) return;
      entries.set(entryKey(asset, cacheKey), {
        assetId: asset.id,
        assetSha256: asset.sha256,
        cacheKey,
        result,
      });
      writes += 1;
      queueSave();
    },
    async remove(asset, cacheKey) {
      if (!options.enabled) return false;
      const deleted = entries.delete(entryKey(asset, cacheKey));
      if (!deleted) return false;
      purgedRows += 1;
      queueSave();
      return true;
    },
    async purge(shouldRemove) {
      if (!options.enabled) return 0;
      let removed = 0;
      for (const [key, entry] of entries) {
        if (!shouldRemove(entry.cacheKey)) continue;
        entries.delete(key);
        removed += 1;
      }
      if (removed === 0) return 0;
      purgedRows += removed;
      queueSave();
      return removed;
    },
    flush,
    summary() {
      return {
        enabled: options.enabled,
        file: options.enabled ? options.file : null,
        hits,
        misses,
        writes,
        invalidRows,
        purgedRows,
      };
    },
  };
};

const readSnapshot = async (file: string): Promise<Map<string, StudyCacheEntry>> => {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<StudyCacheSnapshot>;
    if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object') {
      return new Map();
    }
    return new Map(
      Object.entries(parsed.entries).filter((entry): entry is [string, StudyCacheEntry] =>
        isStudyCacheEntry(entry[1]),
      ),
    );
  } catch {
    return new Map();
  }
};

const isStudyCacheEntry = (value: unknown): value is StudyCacheEntry => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StudyCacheEntry>;
  return (
    typeof candidate.assetId === 'string' &&
    typeof candidate.assetSha256 === 'string' &&
    typeof candidate.cacheKey === 'string' &&
    'result' in candidate
  );
};

const entryKey = (asset: CorpusBenchAsset, cacheKey: string): string => `${asset.id}:${cacheKey}`;
