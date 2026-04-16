import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isEnoentError } from './fs-error.js';

/** Persisted user preference for which app opens preview images. */
export type ViewerPreference =
  | { readonly mode: 'default' }
  | { readonly mode: 'quicklook' }
  | { readonly mode: 'preview' }
  | { readonly mode: 'custom-app'; readonly value: string };

const isViewerPreference = (value: unknown): value is ViewerPreference => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const mode = Reflect.get(value, 'mode');
  if (mode === 'default' || mode === 'quicklook' || mode === 'preview') {
    return true;
  }

  return mode === 'custom-app' && typeof Reflect.get(value, 'value') === 'string';
};

/** Return the absolute path to the corpus-cli JSON config file. */
export const getCorpusCliConfigPath = (repoRoot: string): string => {
  return path.join(repoRoot, '.sc', 'corpus-cli.json');
};

/** Read the saved `ViewerPreference` from config, or `undefined` if not yet set. */
export const readViewerPreference = async (
  repoRoot: string,
): Promise<ViewerPreference | undefined> => {
  try {
    const raw = await readFile(getCorpusCliConfigPath(repoRoot), 'utf8');
    const parsed = JSON.parse(raw) as { viewer?: unknown };
    return isViewerPreference(parsed.viewer) ? parsed.viewer : undefined;
  } catch (error) {
    if (isEnoentError(error)) {
      return undefined;
    }

    throw error;
  }
};

/** Persist the user's `ViewerPreference` to the corpus-cli config file. */
export const writeViewerPreference = async (
  repoRoot: string,
  viewer: ViewerPreference,
): Promise<void> => {
  const configPath = getCorpusCliConfigPath(repoRoot);
  await mkdir(path.dirname(configPath), { recursive: true });
  let existing: Record<string, unknown> = {};
  try {
    const raw = await readFile(configPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch (error) {
    if (!isEnoentError(error)) throw error;
    // File absent — start fresh.
  }
  await writeFile(configPath, `${JSON.stringify({ ...existing, viewer }, null, 2)}\n`, 'utf8');
};
