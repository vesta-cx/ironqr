import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { readGeneratedCorpusManifest, writeGeneratedCorpusManifest } from './manifest.js';
import {
  buildGeneratedAssetRecord,
  buildLocalGeneratedProvenance,
  ensureCommandAvailable,
  importQrProjectBindings,
  parseNumberFlag,
  parseScriptOptions,
  renderQrSvgToPng,
} from './runtime.js';
import {
  FRAME_TEXT_BY_PAYLOAD_TYPE,
  GENERATED_PAYLOAD_TEMPLATES,
  type GeneratedPayloadTemplate,
  type ThemeColors,
} from './spec.js';

const DEFAULT_COUNT_PER_TYPE = 100;
const PIXEL_SIZES = [4, 5, 6, 7, 8, 9, 10, 12] as const;
const ERROR_CORRECTIONS = ['L', 'M', 'Q', 'H'] as const;
const MODULE_STYLES = ['square', 'rounded', 'dots', 'diamond'] as const;
const CAP_STYLES = ['square', 'circle', 'miter'] as const;
const CONNECTION_MODES = ['disconnected', 'lines'] as const;
const GENERATED_REVIEWER = 'generator';

const hashSeed = (value: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const mulberry32 = (seed: number): (() => number) => {
  let current = seed >>> 0;
  return () => {
    current |= 0;
    current = (current + 0x6d2b79f5) | 0;
    let t = Math.imul(current ^ (current >>> 15), 1 | current);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const pick = <T>(values: readonly T[], rng: () => number): T => {
  return values[Math.floor(rng() * values.length)] ?? values[0]!;
};

const enumerateDotSizes = (
  pixelSize: number,
  getMinimumPixelPerfectDotSize: (pixelSize: number) => number,
  normalizeDotSize: (dotSize: number, pixelSize: number) => number,
): number[] => {
  const min = getMinimumPixelPerfectDotSize(pixelSize);
  const step = 1 / pixelSize;
  const dotSizes = new Set<number>();
  for (let value = min; value <= 1 + 1e-9; value += step) {
    dotSizes.add(Number(normalizeDotSize(value, pixelSize).toFixed(6)));
  }
  return [...dotSizes].sort((left, right) => left - right);
};

const createAppearanceKey = (input: {
  readonly payloadType: string;
  readonly errorCorrection: string;
  readonly pixelSize: number;
  readonly moduleStyle: string;
  readonly capStyle: string;
  readonly connectionMode: string;
  readonly dotSize: number;
  readonly themeId?: string;
  readonly frameText?: string;
}): string => JSON.stringify(input);

const createAppearance = (
  payload: GeneratedPayloadTemplate,
  themes: readonly ThemeColors[],
  rng: () => number,
  helpers: {
    readonly getMinimumPixelPerfectDotSize: (pixelSize: number) => number;
    readonly normalizeDotSize: (dotSize: number, pixelSize: number) => number;
    readonly normalizeCapStyle: (capStyle: string, pixelSize: number) => string;
  },
) => {
  const pixelSize = pick(PIXEL_SIZES, rng);
  const dotSize = pick(
    enumerateDotSizes(pixelSize, helpers.getMinimumPixelPerfectDotSize, helpers.normalizeDotSize),
    rng,
  );
  const theme = pick(themes, rng);
  const capStyle = helpers.normalizeCapStyle(pick(CAP_STYLES, rng), pixelSize);
  const frameText = pick(FRAME_TEXT_BY_PAYLOAD_TYPE[payload.type], rng);

  return {
    errorCorrection: pick(ERROR_CORRECTIONS, rng),
    pixelSize,
    moduleStyle: pick(MODULE_STYLES, rng),
    capStyle,
    connectionMode: pick(CONNECTION_MODES, rng),
    dotSize,
    fgColor: theme.fg,
    bgColor: theme.bg,
    themeId: theme.id,
    ...(frameText ? { frameText } : {}),
  };
};

const main = async () => {
  const argv = process.argv.slice(2);
  const options = parseScriptOptions(argv);
  const countPerType = parseNumberFlag(argv, 'count-per-type', DEFAULT_COUNT_PER_TYPE);

  await ensureCommandAvailable('magick');
  const bindings = await importQrProjectBindings(options.qrProjectRoot);
  const manifest = await readGeneratedCorpusManifest(options.repoRoot);

  const existingAppearanceKeys = new Set(
    manifest.assets
      .filter(
        (asset) =>
          asset.synthetic?.source === 'generated' && asset.synthetic.variantKind === 'base',
      )
      .map((asset) => {
        const key = {
          payloadType: asset.synthetic!.payloadType,
          errorCorrection: asset.synthetic!.appearance.errorCorrection,
          pixelSize: asset.synthetic!.appearance.pixelSize,
          moduleStyle: asset.synthetic!.appearance.moduleStyle,
          capStyle: asset.synthetic!.appearance.capStyle,
          connectionMode: asset.synthetic!.appearance.connectionMode,
          dotSize: asset.synthetic!.appearance.dotSize,
          ...(asset.synthetic!.appearance.themeId
            ? { themeId: asset.synthetic!.appearance.themeId }
            : {}),
          ...(asset.synthetic!.appearance.frameText
            ? { frameText: asset.synthetic!.appearance.frameText }
            : {}),
        };
        return createAppearanceKey(key);
      }),
  );

  const nextAssets = [...manifest.assets];
  const seenAssetIds = new Set(nextAssets.map((asset) => asset.id));
  const tempDir = path.join(options.repoRoot, 'corpus', 'generated', '.tmp');
  await mkdir(tempDir, { recursive: true });

  for (const payload of GENERATED_PAYLOAD_TEMPLATES) {
    const existingCount = nextAssets.filter(
      (asset) =>
        asset.synthetic?.source === 'generated' &&
        asset.synthetic.variantKind === 'base' &&
        asset.synthetic.payloadType === payload.type,
    ).length;
    const needed = Math.max(0, countPerType - existingCount);
    if (needed === 0) continue;

    const rng = mulberry32(hashSeed(`${options.seed}:${payload.type}`));
    let created = 0;
    let attempts = 0;
    while (created < needed && attempts < needed * 200) {
      attempts += 1;
      const appearance = createAppearance(payload, bindings.themes, rng, bindings);
      const appearanceKey = createAppearanceKey({ payloadType: payload.type, ...appearance });
      if (existingAppearanceKeys.has(appearanceKey)) {
        continue;
      }

      const encodedData = bindings.encodePayload(payload.type, payload.fields);
      const svg = bindings.generateQRSvg({
        data: encodedData,
        errorCorrection: appearance.errorCorrection,
        pixelSize: appearance.pixelSize,
        moduleStyle: appearance.moduleStyle,
        capStyle: appearance.capStyle,
        connectionMode: appearance.connectionMode,
        dotSize: appearance.dotSize,
        fgColor: appearance.fgColor,
        bgColor: appearance.bgColor,
        ...(appearance.frameText ? { frameText: appearance.frameText } : {}),
      });

      const tempOutputPath = path.join(tempDir, `${payload.type}-${created}-${attempts}.png`);
      await renderQrSvgToPng(svg, tempOutputPath);
      const asset = await buildGeneratedAssetRecord({
        repoRoot: options.repoRoot,
        outputPath: tempOutputPath,
        label: 'qr-positive',
        provenance: [
          buildLocalGeneratedProvenance(
            options.qrProjectRoot,
            `Generated base QR with ${path.relative(options.repoRoot, options.qrProjectRoot)}`,
          ),
        ],
        review: {
          status: 'approved',
          reviewer: GENERATED_REVIEWER,
          reviewedAt: new Date().toISOString(),
          notes: 'Synthetic generated base asset',
        },
        groundTruth: {
          qrCount: 1,
          codes: [{ text: encodedData, kind: payload.type }],
        },
        synthetic: {
          source: 'generated',
          generator: 'mia-cx/qr',
          variantKind: 'base',
          seed: options.seed,
          payloadType: payload.type,
          payloadFields: payload.fields,
          encodedData,
          appearance,
          transformations: [],
        },
      });
      await rm(tempOutputPath, { force: true });

      if (seenAssetIds.has(asset.id)) {
        existingAppearanceKeys.add(appearanceKey);
        continue;
      }

      nextAssets.push(asset);
      seenAssetIds.add(asset.id);
      existingAppearanceKeys.add(appearanceKey);
      created += 1;
    }

    if (created < needed) {
      throw new Error(
        `Only generated ${created} unique base variants for ${payload.type}; expected ${needed}`,
      );
    }
  }

  await writeGeneratedCorpusManifest(options.repoRoot, {
    version: manifest.version,
    assets: nextAssets,
  });
};

await main();
