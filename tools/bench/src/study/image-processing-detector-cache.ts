import type { BinaryViewId } from '../../../../packages/ironqr/src/pipeline/views.js';
import type { VariantCacheMeasurement } from './image-processing-types.js';
import type { StudyCacheHandle } from './types.js';

interface DetectorCachePurger {
  readonly purge: (predicate: (cacheKey: string) => boolean) => Promise<number>;
}

interface DetectorTimingLogger {
  readonly log: (message: string) => void;
  readonly logTiming: (
    id: string,
    durationMs: number,
    group: 'view' | 'detector',
    outputCount: number,
    cached?: boolean,
  ) => void;
  readonly yieldToDashboard: () => Promise<void>;
}

export const detectorVariantCacheKey = (variantId: string, viewId: BinaryViewId): string =>
  JSON.stringify({
    kind: 'detector-pattern',
    version: variantId === 'row-scan' ? 3 : 2,
    patternId: detectorPatternId(variantId, viewId),
  });

export const detectorVariantCacheKeys = (
  variantId: string,
  viewId: BinaryViewId,
): readonly string[] => {
  const keys = new Set<string>([detectorVariantCacheKey(variantId, viewId)]);
  if (variantId === 'row-scan') return [...keys];
  for (const legacyId of [variantId, ...(LEGACY_VARIANT_IDS[variantId] ?? [])]) {
    keys.add(
      JSON.stringify({
        kind: 'detector-pattern',
        version: 1,
        patternId: legacyDetectorPatternId(legacyId, viewId),
      }),
    );
    keys.add(
      JSON.stringify({
        kind: 'detector-pattern',
        version: 2,
        patternId: `${legacyShortVariantId(legacyId)}:${detectorAreaId(legacyId)}:${shortBinaryViewId(viewId)}`,
      }),
    );
    keys.add(JSON.stringify({ kind: 'detector-variant', version: 1, variantId: legacyId, viewId }));
  }
  return [...keys];
};

export const detectorPatternId = (variantId: string, viewId: BinaryViewId): string =>
  `${detectorPatternPrefix(variantId)}${shortBinaryViewId(viewId)}`;

export const detectorPatternPrefix = (variantId: string): string =>
  `${shortVariantId(variantId)}:${detectorAreaId(variantId)}:`;

export const legacyDetectorPatternPrefix = (variantId: string): string => {
  const area = detectorAreaId(variantId) === 'f' ? 'flood' : 'matcher';
  const shortId = variantId
    .replace(/-control$/, '')
    .replace(/-candidate$/, '')
    .replace(/-components?/, '')
    .replace(/-connected-/, '-ccl-');
  return `${shortId}:${area}:`;
};

export const detectorAreaId = (variantId: string): 'f' | 'm' =>
  FLOOD_DETECTOR_IDS.has(variantId) ? 'f' : 'm';

export const legacyShortVariantId = (variantId: string): string =>
  LEGACY_VARIANT_ALIASES[variantId] ?? shortVariantId(variantId);

export const detectorTimingId = (
  viewId: BinaryViewId,
  variant: string,
  detector: string,
): string => {
  const [scalar = '', threshold = '', polarity = ''] = viewId.split(':');
  return `${shortVariantId(variant)}:${shortDetectorFamily(detector)}:${shortBinaryViewPart(scalar)}:${shortBinaryViewPart(threshold)}:${shortBinaryViewPart(polarity)}`;
};

export const replayCachedDetectorRows = async (
  asset: Parameters<StudyCacheHandle['read']>[0],
  cache: Pick<StudyCacheHandle, 'has' | 'read'>,
  viewIds: readonly BinaryViewId[],
  variantIds: readonly string[],
  preloadedRows: Set<string>,
  logger: DetectorTimingLogger,
): Promise<number> => {
  let replayed = 0;
  for (const viewId of viewIds) {
    await logger.yieldToDashboard();
    for (const variantId of variantIds) {
      const measurement = await readDetectorVariantMeasurement(asset, cache, variantId, viewId);
      if (!measurement) continue;
      replayed += 1;
      preloadedRows.add(detectorRowKey(asset.id, variantId, viewId));
      const detector = detectorAreaId(variantId) === 'f' ? 'flood' : 'matcher';
      logger.logTiming(
        detectorTimingId(viewId, variantId, detector),
        measurement.durationMs,
        'detector',
        measurement.outputCount,
        true,
      );
    }
  }
  return replayed;
};

export const detectorRowKey = (assetId: string, variantId: string, viewId: BinaryViewId): string =>
  `${assetId}\u0000${variantId}\u0000${viewId}`;

export const isPreloadedDetectorRow = (
  assetId: string,
  variantId: string,
  viewId: BinaryViewId,
  preloadedRows: ReadonlySet<string>,
): boolean =>
  preloadedRows.has(detectorRowKey(assetId, variantId, viewId)) ||
  Reflect.get(globalThis, '__BENCH_STUDY_WORKER__') === true;

export const readDetectorVariantMeasurement = async (
  asset: Parameters<StudyCacheHandle['read']>[0],
  cache: Pick<StudyCacheHandle, 'has' | 'read'>,
  variantId: string,
  viewId: BinaryViewId,
): Promise<VariantCacheMeasurement | null> => {
  for (const cacheKey of detectorVariantCacheKeys(variantId, viewId)) {
    if (!cache.has(asset, cacheKey)) continue;
    const value = await cache.read(asset, cacheKey);
    if (isVariantCacheMeasurement(value)) return value;
  }
  return null;
};

export const isVariantCacheMeasurement = (value: unknown): value is VariantCacheMeasurement => {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { durationMs?: unknown }).durationMs !== 'number' ||
    typeof (value as { outputCount?: unknown }).outputCount !== 'number' ||
    !Array.isArray((value as { signature?: unknown }).signature)
  ) {
    return false;
  }

  const measurement = value as VariantCacheMeasurement;
  return measurement.outputCount === 0 || measurement.signature.length > 0;
};

export const purgeRedundantDetectorCacheRows = async (
  cache: DetectorCachePurger,
  retainedVariantIds: readonly string[],
  log: (message: string) => void,
): Promise<void> => {
  const startedAt = performance.now();
  const purged = await cache.purge((cacheKey) =>
    shouldPurgeDetectorCacheKey(cacheKey, retainedVariantIds),
  );
  const elapsed = round(performance.now() - startedAt);
  log(
    purged > 0
      ? `detector cache purge complete: removed ${purged} binned pattern rows in ${elapsed}ms`
      : `detector cache purge complete: no binned pattern rows found in ${elapsed}ms`,
  );
};

const shouldPurgeDetectorCacheKey = (
  cacheKey: string,
  retainedVariantIds: readonly string[],
): boolean => {
  const activeVariantIds = retainedVariantIds.flatMap((variantId) => [
    variantId,
    ...(LEGACY_VARIANT_IDS[variantId] ?? []),
  ]);
  const activePatternPrefixes = new Set(
    activeVariantIds.flatMap((variantId) => [
      detectorPatternPrefix(variantId),
      legacyDetectorPatternPrefix(variantId),
      `${legacyShortVariantId(variantId)}:${detectorAreaId(variantId)}:`,
    ]),
  );
  const parsed = parseDetectorCacheKey(cacheKey);
  if (!parsed) return false;
  if (parsed.kind === 'detector-variant') return !activeVariantIds.includes(parsed.variantId);
  return ![...activePatternPrefixes].some((prefix) => parsed.patternId.startsWith(prefix));
};

export const parseDetectorCacheKey = (
  cacheKey: string,
):
  | { readonly kind: 'detector-variant'; readonly variantId: string }
  | { readonly kind: 'detector-pattern'; readonly patternId: string }
  | null => {
  try {
    const parsed = JSON.parse(cacheKey) as Record<string, unknown>;
    if (parsed.kind === 'detector-variant' && typeof parsed.variantId === 'string') {
      return { kind: 'detector-variant', variantId: parsed.variantId };
    }
    if (parsed.kind === 'detector-pattern' && typeof parsed.patternId === 'string') {
      return { kind: 'detector-pattern', patternId: parsed.patternId };
    }
  } catch {
    return null;
  }
  return null;
};

export const LEGACY_VARIANT_IDS: Record<string, readonly string[]> = {
  'legacy-flood': ['legacy-two-pass-flood'],
  'inline-flood': ['inline-flood-control'],
  'legacy-matcher': ['legacy-matcher-control'],
  'run-map': ['run-map-matcher-control'],
  'dense-stats': ['dense-typed-array-component-stats'],
  'dense-index': ['dense-indexed-component-lookup'],
  'dense-squared': ['dense-squared-distance'],
  'dense-index-squared': ['dense-indexed-squared-distance'],
  'scanline-stats': ['scanline-component-stats'],
  'scanline-index': ['scanline-indexed-component-lookup'],
  'scanline-squared': ['scanline-squared-distance'],
  'scanline-index-squared': ['scanline-indexed-squared-distance'],
  'spatial-bin': ['spatial-binned-component-lookup'],
  'run-length-ccl': ['run-length-connected-components'],
  'run-pattern': ['run-pattern-center-matcher'],
  'axis-intersect': ['axis-run-intersection-matcher'],
  'shared-runs': ['shared-run-length-detector-artifacts'],
};

const legacyDetectorPatternId = (variantId: string, viewId: BinaryViewId): string =>
  `${legacyDetectorPatternPrefix(variantId)}${viewId}`;

export const shortVariantId = (variantId: string): string =>
  VARIANT_ID_ALIASES[variantId] ??
  variantId
    .replace(/-control$/, '')
    .replace(/-matcher$/, '')
    .replace(/-components?/, '')
    .replace(/-connected-/, '-ccl-');

export const shortDetectorFamily = (detector: string): string =>
  DETECTOR_FAMILY_ALIASES[detector] ?? detector;

const shortBinaryViewId = (viewId: BinaryViewId): string => {
  const [scalar = '', threshold = '', polarity = ''] = viewId.split(':');
  return `${shortBinaryViewPart(scalar)}:${shortBinaryViewPart(threshold)}:${shortBinaryViewPart(polarity)}`;
};

export const shortBinaryViewPart = (part: string): string => BINARY_VIEW_PART_ALIASES[part] ?? part;

const VARIANT_ID_ALIASES: Record<string, string> = {
  'row-scan': 'row-scan',
  'row-scan-scalar-score': 'row-scan-scalar',
  'row-scan-u16': 'row-scan-u16',
  'row-scan-u16-scalar-score': 'row-scan-u16-scalar',
  'row-scan-packed-u16': 'row-scan-pack-u16',
  'row-scan-packed-u16-scalar-score': 'row-scan-pack-u16-scalar',
  dedupe: 'dedupe',
  'legacy-flood': 'legacy-flood',
  'inline-flood': 'inline',
  'legacy-matcher': 'legacy-match',
  'run-map': 'run-map',
  'dense-stats': 'dense',
  'dense-index': 'dense-index',
  'dense-squared': 'dense-sq',
  'dense-index-squared': 'dense-idx-sq',
  'scanline-stats': 'scanline',
  'scanline-index': 'scan-idx',
  'scanline-squared': 'scan-sq',
  'scanline-index-squared': 'scan-idx-sq',
  'spatial-bin': 'spatial',
  'run-length-ccl': 'run-length',
  'run-pattern': 'run-pattern',
  'axis-intersect': 'axis-x',
  'shared-runs': 'shared-runs',
  'run-map-u16': 'run-map-u16',
  'run-map-u16-fill-horizontal': 'run-map-u16-fill-h',
  'run-map-scalar-score': 'run-map-scalar',
  'run-map-u16-scalar-score': 'run-map-u16-scalar',
  'run-map-packed-u16': 'run-map-pack-u16',
  'run-map-packed-u16-fill-horizontal': 'run-map-pack-u16-fill-h',
  'run-map-packed-u16-scalar-score': 'run-map-pack-u16-scalar',
};

const LEGACY_VARIANT_ALIASES: Record<string, string> = {
  'legacy-two-pass-flood': 'legacy-flood',
  'inline-flood-control': 'in',
  'legacy-matcher-control': 'legacy-match',
  'run-map-matcher-control': 'rm',
  'dense-typed-array-component-stats': 'dta',
  'dense-indexed-component-lookup': 'di',
  'dense-squared-distance': 'dsq',
  'dense-indexed-squared-distance': 'disq',
  'scanline-component-stats': 'sl',
  'scanline-indexed-component-lookup': 'sli',
  'scanline-squared-distance': 'slsq',
  'scanline-indexed-squared-distance': 'slisq',
  'spatial-binned-component-lookup': 'sb',
  'run-length-connected-components': 'rlc',
  'run-pattern-center-matcher': 'rpc',
  'axis-run-intersection-matcher': 'ari',
  'shared-run-length-detector-artifacts': 'srla',
};

const FLOOD_DETECTOR_IDS = new Set([
  'legacy-flood',
  'inline-flood',
  'dense-stats',
  'dense-index',
  'dense-squared',
  'dense-index-squared',
  'scanline-stats',
  'scanline-index',
  'scanline-squared',
  'scanline-index-squared',
  'spatial-bin',
  'run-length-ccl',
  'inline-flood-control',
  'dense-typed-array-component-stats',
  'dense-indexed-component-lookup',
  'dense-squared-distance',
  'dense-indexed-squared-distance',
  'scanline-component-stats',
  'scanline-indexed-component-lookup',
  'scanline-squared-distance',
  'scanline-indexed-squared-distance',
  'spatial-binned-component-lookup',
  'run-length-connected-components',
  'legacy-two-pass-flood',
]);

const round = (value: number): number => Math.round(value * 100) / 100;

const DETECTOR_FAMILY_ALIASES: Record<string, string> = {
  flood: 'f',
  matcher: 'm',
  row: 'r',
  dedupe: 'd',
};

const BINARY_VIEW_PART_ALIASES: Record<string, string> = {
  otsu: 'o',
  sauvola: 's',
  hybrid: 'h',
  normal: 'n',
  inverted: 'i',
};
