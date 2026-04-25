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
  let saveCounter = 0;
  let saveTail = Promise.resolve();

  const save = async (): Promise<void> => {
    if (!options.enabled) return;
    saveTail = saveTail.then(async () => {
      const snapshot: StudyCacheSnapshot = {
        version: 1,
        entries: Object.fromEntries(entries),
      };
      await mkdir(path.dirname(options.file), { recursive: true });
      saveCounter += 1;
      const tempFile = `${options.file}.${process.pid}.${Date.now()}.${saveCounter}.tmp`;
      await writeFile(tempFile, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      await rename(tempFile, options.file);
    });
    await saveTail;
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
      const entry = entries.get(entryKey(asset, cacheKey));
      if (!entry) {
        misses += 1;
        return null;
      }
      if (entry.assetSha256 !== asset.sha256 || entry.cacheKey !== cacheKey) {
        entries.delete(entryKey(asset, cacheKey));
        invalidRows += 1;
        misses += 1;
        await save();
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
      await save();
    },
    async remove(asset, cacheKey) {
      if (!options.enabled) return false;
      const deleted = entries.delete(entryKey(asset, cacheKey));
      if (!deleted) return false;
      await save();
      return true;
    },
    summary() {
      return {
        enabled: options.enabled,
        file: options.enabled ? options.file : null,
        hits,
        misses,
        writes,
        invalidRows,
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
