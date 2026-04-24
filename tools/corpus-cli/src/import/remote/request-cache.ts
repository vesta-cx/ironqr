import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isEnoentError } from '../../fs-error.js';
import { hashSha256 } from '../store.js';

interface CachedValue<T> {
  readonly cachedAt: string;
  readonly value: T;
}

export interface RequestCacheOptions {
  readonly repoRoot: string;
  readonly namespace: string;
  readonly cacheKey: string;
  readonly ttlMs: number;
}

const getRequestCachePath = (options: RequestCacheOptions): string => {
  const hashedKey = hashSha256(new TextEncoder().encode(options.cacheKey));
  return path.join(
    options.repoRoot,
    '.sc',
    'request-cache',
    options.namespace,
    `${hashedKey}.json`,
  );
};

/** Read a cached request value when it exists and has not expired. */
export const readRequestCache = async <T>(options: RequestCacheOptions): Promise<T | null> => {
  try {
    const raw = await readFile(getRequestCachePath(options), 'utf8');
    const parsed = JSON.parse(raw) as CachedValue<T>;
    const cachedAt = Date.parse(parsed.cachedAt);
    if (Number.isNaN(cachedAt) || Date.now() - cachedAt >= options.ttlMs) {
      return null;
    }
    return parsed.value;
  } catch (error) {
    if (isEnoentError(error)) return null;
    throw error;
  }
};

/** Persist a request value under the caller-provided cache namespace/key. */
export const writeRequestCache = async <T>(
  options: RequestCacheOptions,
  value: T,
): Promise<void> => {
  const filePath = getRequestCachePath(options);
  await mkdir(path.dirname(filePath), { recursive: true });
  const payload: CachedValue<T> = {
    cachedAt: new Date().toISOString(),
    value,
  };
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
};
