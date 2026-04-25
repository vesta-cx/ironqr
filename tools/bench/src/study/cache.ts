import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CorpusBenchAsset } from '../accuracy/types.js';
import type { StudyCacheHandle } from './types.js';

interface StudyCacheEntry {
  readonly assetId: string;
  readonly assetSha256: string;
  readonly cacheKey: string;
  readonly result: unknown;
}

interface StudyCacheV1Snapshot {
  readonly version: 1;
  readonly entries: Record<string, StudyCacheEntry>;
}

interface StudyCacheV2AssetRows {
  readonly sha: string;
  readonly entries: Record<string, unknown>;
}

interface StudyCacheV2Snapshot {
  readonly version: 2;
  readonly assets: Record<string, StudyCacheV2AssetRows>;
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
    await writeSnapshot(options.file, entries, () => {
      saveCounter += 1;
      return `${process.pid}.${Date.now()}.${saveCounter}`;
    });
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

export const migrateStudyCacheFile = async (
  file: string,
): Promise<{
  readonly entries: number;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
}> => {
  const bytesBefore = await fileSize(file);
  const entries = await readSnapshot(file);
  await writeSnapshot(file, entries, () => `migrate.${process.pid}.${Date.now()}`);
  return { entries: entries.size, bytesBefore, bytesAfter: await fileSize(file) };
};

const readSnapshot = async (file: string): Promise<Map<string, StudyCacheEntry>> => {
  try {
    return snapshotEntries(JSON.parse(await readFile(file, 'utf8')) as unknown);
  } catch {
    return new Map();
  }
};

const snapshotEntries = (parsed: unknown): Map<string, StudyCacheEntry> => {
  if (isV2Snapshot(parsed)) return entriesFromV2(parsed);
  if (isV1Snapshot(parsed)) {
    return new Map(
      Object.entries(parsed.entries).filter((entry): entry is [string, StudyCacheEntry] =>
        isStudyCacheEntry(entry[1]),
      ),
    );
  }
  return new Map();
};

const entriesFromV2 = (snapshot: StudyCacheV2Snapshot): Map<string, StudyCacheEntry> => {
  const entries = new Map<string, StudyCacheEntry>();
  for (const [assetId, assetRows] of Object.entries(snapshot.assets)) {
    for (const [cacheKey, result] of Object.entries(assetRows.entries)) {
      const entry = {
        assetId,
        assetSha256: assetRows.sha,
        cacheKey,
        result,
      } satisfies StudyCacheEntry;
      entries.set(entryKeyParts(assetId, cacheKey), entry);
    }
  }
  return entries;
};

const writeSnapshot = async (
  file: string,
  entries: ReadonlyMap<string, StudyCacheEntry>,
  nonce: () => string,
): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true });
  const tempFile = `${file}.${nonce()}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(toV2Snapshot(entries))}\n`, 'utf8');
  await rename(tempFile, file);
};

const toV2Snapshot = (entries: ReadonlyMap<string, StudyCacheEntry>): StudyCacheV2Snapshot => {
  const assets: Record<string, StudyCacheV2AssetRows> = {};
  for (const entry of entries.values()) {
    let assetRows = assets[entry.assetId];
    if (!assetRows) {
      assetRows = { sha: entry.assetSha256, entries: {} };
      assets[entry.assetId] = assetRows;
    }
    assetRows.entries[entry.cacheKey] = entry.result;
  }
  return { version: 2, assets };
};

const isV1Snapshot = (value: unknown): value is StudyCacheV1Snapshot => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StudyCacheV1Snapshot>;
  return (
    candidate.version === 1 && Boolean(candidate.entries) && typeof candidate.entries === 'object'
  );
};

const isV2Snapshot = (value: unknown): value is StudyCacheV2Snapshot => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StudyCacheV2Snapshot>;
  return (
    candidate.version === 2 && Boolean(candidate.assets) && typeof candidate.assets === 'object'
  );
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

const fileSize = async (file: string): Promise<number> => (await stat(file)).size;

const entryKey = (asset: CorpusBenchAsset, cacheKey: string): string =>
  entryKeyParts(asset.id, cacheKey);
const entryKeyParts = (assetId: string, cacheKey: string): string => `${assetId}:${cacheKey}`;
