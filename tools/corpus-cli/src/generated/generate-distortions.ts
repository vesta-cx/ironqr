import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { readCorpusManifest } from '../manifest.js';
import { readGeneratedCorpusManifest, writeGeneratedCorpusManifest } from './manifest.js';
import {
  buildGeneratedAssetRecord,
  buildLocalGeneratedProvenance,
  ensureCommandAvailable,
  getGeneratedAssetPath,
  parseNumberFlag,
  parseScriptOptions,
  runCommand,
} from './runtime.js';
import {
  assignRecipesToBases,
  buildGeneratedRecipeCatalog,
  type GeneratedRecipeStep,
} from './spec.js';

const GENERATED_REVIEWER = 'generator';
const DEFAULT_COVERAGE_MIN = 1;
const DEFAULT_COVERAGE_MAX = 3;
const DEFAULT_RECIPE_SEED_SUFFIX = 'distortions';
const DEFAULT_BASE_QUIET_ZONE_MODULES = 4;

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

const withTempPath = (tempDir: string, label: string): string =>
  path.join(
    tempDir,
    `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.png`,
  );

const getMetadata = async (
  filePath: string,
): Promise<{ readonly width: number; readonly height: number }> => {
  const metadata = await sharp(filePath).metadata();
  return {
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
  };
};

const anchorOffset = (
  anchor: string,
  containerWidth: number,
  containerHeight: number,
  contentWidth: number,
  contentHeight: number,
): { readonly x: number; readonly y: number; readonly gravity: string } => {
  if (anchor === 'center') {
    return { x: 0, y: 0, gravity: 'center' };
  }
  if (anchor === 'top-left') {
    return {
      x: Math.round((containerWidth - contentWidth) * -0.25),
      y: Math.round((containerHeight - contentHeight) * -0.25),
      gravity: 'center',
    };
  }
  if (anchor === 'top') {
    return { x: 0, y: Math.round((containerHeight - contentHeight) * -0.28), gravity: 'center' };
  }
  if (anchor === 'right') {
    return { x: Math.round((containerWidth - contentWidth) * 0.28), y: 0, gravity: 'center' };
  }
  if (anchor === 'bottom') {
    return { x: 0, y: Math.round((containerHeight - contentHeight) * 0.28), gravity: 'center' };
  }
  return {
    x: Math.round((containerWidth - contentWidth) * 0.18),
    y: Math.round((containerHeight - contentHeight) * -0.18),
    gravity: 'center',
  };
};

const buildPerspectiveCoordinates = (
  width: number,
  height: number,
  direction: string,
  amount: number,
): string => {
  const dx = Math.round(width * amount);
  const dy = Math.round(height * amount);
  const left = 0;
  const top = 0;
  const right = width - 1;
  const bottom = height - 1;

  const points: Array<[number, number, number, number]> = [
    [left, top, left, top],
    [right, top, right, top],
    [left, bottom, left, bottom],
    [right, bottom, right, bottom],
  ];

  if (direction === 'tl') points[0] = [left, top, left + dx, top + dy];
  if (direction === 'tr') points[1] = [right, top, right - dx, top + dy];
  if (direction === 'bl') points[2] = [left, bottom, left + dx, bottom - dy];
  if (direction === 'br') points[3] = [right, bottom, right - dx, bottom - dy];

  return points.flat().join(' ');
};

const runMagickOrFfmpeg = async (options: {
  readonly magickArgs: readonly string[];
  readonly ffmpegArgs?: readonly string[];
}): Promise<void> => {
  try {
    await runCommand('magick', options.magickArgs, { quiet: true });
  } catch (error) {
    if (!options.ffmpegArgs) throw error;
    await runCommand('ffmpeg', options.ffmpegArgs, { quiet: true });
  }
};

const applyPerspective = async (
  inputPath: string,
  outputPath: string,
  background: string,
  step: GeneratedRecipeStep,
): Promise<void> => {
  const { width, height } = await getMetadata(inputPath);
  await runMagickOrFfmpeg({
    magickArgs: [
      inputPath,
      '-virtual-pixel',
      'background',
      '-background',
      background,
      '+distort',
      'Perspective',
      buildPerspectiveCoordinates(width, height, step.direction ?? 'br', step.amount ?? 0.05),
      outputPath,
    ],
  });
};

const applySquish = async (
  inputPath: string,
  outputPath: string,
  background: string,
  step: GeneratedRecipeStep,
): Promise<void> => {
  const { width, height } = await getMetadata(inputPath);
  const scale = step.amount ?? 0.9;
  const resizeArg =
    step.axis === 'y'
      ? `${width}x${Math.max(1, Math.round(height * scale))}!`
      : `${Math.max(1, Math.round(width * scale))}x${height}!`;
  await runMagickOrFfmpeg({
    magickArgs: [
      inputPath,
      '-resize',
      resizeArg,
      '-background',
      background,
      '-gravity',
      'center',
      '-extent',
      `${width}x${height}`,
      outputPath,
    ],
  });
};

const applyBulge = async (inputPath: string, outputPath: string, step: GeneratedRecipeStep) => {
  await runMagickOrFfmpeg({
    magickArgs: [inputPath, '-implode', String(-(step.amount ?? 0.15)), outputPath],
  });
};

const applyCylinderWrap = async (
  inputPath: string,
  outputPath: string,
  background: string,
  step: GeneratedRecipeStep,
): Promise<void> => {
  const amplitude = Math.max(1, Math.round(((step.amount ?? 0.04) * 100) / 2));
  const wavelength = 180;
  const baseArgs = [inputPath, '-background', background];
  if (step.axis === 'y') {
    await runMagickOrFfmpeg({
      magickArgs: [
        ...baseArgs,
        '-rotate',
        '90',
        '-wave',
        `${amplitude}x${wavelength}`,
        '-rotate',
        '-90',
        outputPath,
      ],
    });
    return;
  }

  await runMagickOrFfmpeg({
    magickArgs: [...baseArgs, '-wave', `${amplitude}x${wavelength}`, outputPath],
  });
};

const applyNoise = async (inputPath: string, outputPath: string, step: GeneratedRecipeStep) => {
  await runMagickOrFfmpeg({
    magickArgs: [
      inputPath,
      '-attenuate',
      String(step.amount ?? 1),
      '+noise',
      'Gaussian',
      outputPath,
    ],
    ffmpegArgs: [
      '-y',
      '-i',
      inputPath,
      '-vf',
      `noise=alls=${Math.round((step.amount ?? 1) * 8)}:allf=t+u`,
      outputPath,
    ],
  });
};

const applyBlur = async (inputPath: string, outputPath: string, step: GeneratedRecipeStep) => {
  await runMagickOrFfmpeg({
    magickArgs: [inputPath, '-gaussian-blur', `0x${step.amount ?? 0.8}`, outputPath],
    ffmpegArgs: ['-y', '-i', inputPath, '-vf', `gblur=sigma=${step.amount ?? 0.8}`, outputPath],
  });
};

const applyQuietZone = async (
  inputPath: string,
  outputPath: string,
  background: string,
  step: GeneratedRecipeStep,
  pixelSize: number,
): Promise<void> => {
  const { width, height } = await getMetadata(inputPath);
  const deltaModules = Math.round(step.amount ?? 0);
  const borderPx = deltaModules * pixelSize;

  if (borderPx >= 0) {
    await runMagickOrFfmpeg({
      magickArgs: [
        inputPath,
        '-background',
        background,
        '-gravity',
        'center',
        '-extent',
        `${width + borderPx * 2}x${height + borderPx * 2}`,
        outputPath,
      ],
    });
    return;
  }

  const cropPx = Math.min(Math.abs(borderPx), Math.floor(Math.min(width, height) * 0.2));
  await runMagickOrFfmpeg({
    magickArgs: [
      inputPath,
      '-gravity',
      'center',
      '-crop',
      `${Math.max(1, width - cropPx * 2)}x${Math.max(1, height - cropPx * 2)}+0+0`,
      '+repage',
      outputPath,
    ],
  });
};

const applyDeadzone = async (
  inputPath: string,
  outputPath: string,
  background: string,
  step: GeneratedRecipeStep,
): Promise<void> => {
  const { width, height } = await getMetadata(inputPath);
  const size = Math.max(2, Math.round(Math.min(width, height) * (step.amount ?? 0.08)));
  const anchor = String(step.parameters?.anchor ?? 'center');
  const left =
    anchor === 'top-left'
      ? Math.round(width * 0.08)
      : anchor === 'right'
        ? Math.round(width * 0.72)
        : anchor === 'top'
          ? Math.round(width * 0.4)
          : anchor === 'bottom'
            ? Math.round(width * 0.4)
            : Math.round((width - size) / 2);
  const top =
    anchor === 'top-left'
      ? Math.round(height * 0.08)
      : anchor === 'right'
        ? Math.round(height * 0.42)
        : anchor === 'top'
          ? Math.round(height * 0.08)
          : anchor === 'bottom'
            ? Math.round(height * 0.72)
            : Math.round((height - size) / 2);
  await runMagickOrFfmpeg({
    magickArgs: [
      inputPath,
      '-fill',
      background,
      '-draw',
      `rectangle ${left},${top} ${left + size},${top + size}`,
      outputPath,
    ],
  });
};

const applyRotation = async (
  inputPath: string,
  outputPath: string,
  background: string,
  step: GeneratedRecipeStep,
): Promise<void> => {
  const { width, height } = await getMetadata(inputPath);
  await runMagickOrFfmpeg({
    magickArgs: [
      inputPath,
      '-background',
      background,
      '-rotate',
      String(step.amount ?? 0),
      '-gravity',
      'center',
      '-crop',
      `${width}x${height}+0+0`,
      '+repage',
      outputPath,
    ],
  });
};

const applyCompression = async (
  inputPath: string,
  outputPath: string,
  step: GeneratedRecipeStep,
) => {
  const tempJpegPath = `${outputPath}.jpg`;
  try {
    await runCommand('magick', [inputPath, '-quality', String(step.quality ?? 80), tempJpegPath], {
      quiet: true,
    });
    await runCommand('magick', [tempJpegPath, outputPath], { quiet: true });
  } finally {
    await rm(tempJpegPath, { force: true });
  }
};

const applyContrast = async (inputPath: string, outputPath: string, step: GeneratedRecipeStep) => {
  const gamma = Number(step.parameters?.gamma ?? 1);
  const amount = Math.round(step.amount ?? 0);
  await runMagickOrFfmpeg({
    magickArgs: [
      inputPath,
      '-brightness-contrast',
      `${amount}x${amount}`,
      '-gamma',
      String(gamma),
      outputPath,
    ],
  });
};

const applyBackgroundBlend = async (options: {
  readonly inputPath: string;
  readonly outputPath: string;
  readonly backgroundAssetPath: string;
  readonly step: GeneratedRecipeStep;
}): Promise<void> => {
  const { width, height } = await getMetadata(options.inputPath);
  const anchor = String(options.step.parameters?.anchor ?? 'center');
  const overlayWidth = Math.max(8, Math.round(width * (options.step.scale ?? 0.7)));
  const overlayHeight = Math.max(8, Math.round(height * (options.step.scale ?? 0.7)));
  const offset = anchorOffset(anchor, width, height, overlayWidth, overlayHeight);

  await runMagickOrFfmpeg({
    magickArgs: [
      options.backgroundAssetPath,
      '-resize',
      `${width}x${height}^`,
      '-gravity',
      'center',
      '-extent',
      `${width}x${height}`,
      '(',
      options.inputPath,
      '-resize',
      `${overlayWidth}x${overlayHeight}!`,
      '-alpha',
      'set',
      '-channel',
      'A',
      '-evaluate',
      'multiply',
      String(options.step.opacity ?? 0.3),
      '+channel',
      ')',
      '-gravity',
      offset.gravity,
      '-geometry',
      `${offset.x >= 0 ? '+' : ''}${offset.x}${offset.y >= 0 ? '+' : ''}${offset.y}`,
      '-compose',
      options.step.mode ?? 'over',
      '-composite',
      options.outputPath,
    ],
  });
};

const backgroundChoice = <T>(items: readonly T[], seed: string): T => {
  const rng = mulberry32(hashSeed(seed));
  return items[Math.floor(rng() * items.length)] ?? items[0]!;
};

const applyRecipeStep = async (options: {
  readonly inputPath: string;
  readonly outputPath: string;
  readonly step: GeneratedRecipeStep;
  readonly background: string;
  readonly pixelSize: number;
  readonly backgroundAssetPath?: string;
}): Promise<void> => {
  switch (options.step.kind) {
    case 'perspective':
      return applyPerspective(
        options.inputPath,
        options.outputPath,
        options.background,
        options.step,
      );
    case 'squish':
      return applySquish(options.inputPath, options.outputPath, options.background, options.step);
    case 'bulge':
      return applyBulge(options.inputPath, options.outputPath, options.step);
    case 'cylinder-wrap':
      return applyCylinderWrap(
        options.inputPath,
        options.outputPath,
        options.background,
        options.step,
      );
    case 'noise':
      return applyNoise(options.inputPath, options.outputPath, options.step);
    case 'blur':
      return applyBlur(options.inputPath, options.outputPath, options.step);
    case 'quiet-zone':
      return applyQuietZone(
        options.inputPath,
        options.outputPath,
        options.background,
        options.step,
        options.pixelSize,
      );
    case 'deadzone':
      return applyDeadzone(options.inputPath, options.outputPath, options.background, options.step);
    case 'rotation':
      return applyRotation(options.inputPath, options.outputPath, options.background, options.step);
    case 'compression':
      return applyCompression(options.inputPath, options.outputPath, options.step);
    case 'contrast':
      return applyContrast(options.inputPath, options.outputPath, options.step);
    case 'background-blend':
      if (!options.backgroundAssetPath) {
        throw new Error('Background-blend recipe requires a negative background asset');
      }
      return applyBackgroundBlend({
        inputPath: options.inputPath,
        outputPath: options.outputPath,
        backgroundAssetPath: options.backgroundAssetPath,
        step: options.step,
      });
    default:
      throw new Error(`Unsupported recipe step: ${options.step.kind}`);
  }
};

const main = async () => {
  const argv = process.argv.slice(2);
  const options = parseScriptOptions(argv);
  const coverageMin = parseNumberFlag(argv, 'coverage-min', DEFAULT_COVERAGE_MIN);
  const coverageMax = parseNumberFlag(argv, 'coverage-max', DEFAULT_COVERAGE_MAX);
  if (coverageMin <= 0 || coverageMax < coverageMin || coverageMax > 3) {
    throw new Error('Expected 1 <= --coverage-min <= --coverage-max <= 3');
  }

  await ensureCommandAvailable('magick');
  await ensureCommandAvailable('ffmpeg');

  const generatedManifest = await readGeneratedCorpusManifest(options.repoRoot);
  const baseAssets = generatedManifest.assets.filter(
    (asset) => asset.synthetic?.source === 'generated' && asset.synthetic.variantKind === 'base',
  );
  if (baseAssets.length === 0) {
    throw new Error('No generated base assets found. Run corpus:generate-bases first.');
  }

  const canonicalManifest = await readCorpusManifest(options.repoRoot);
  const negativeAssets = canonicalManifest.assets.filter(
    (asset) => asset.label === 'qr-neg' && asset.review.status === 'approved',
  );
  if (negativeAssets.length === 0) {
    throw new Error('Need at least one approved qr-neg asset for background blending.');
  }

  const recipes = buildGeneratedRecipeCatalog();
  const assignments = assignRecipesToBases(
    recipes,
    baseAssets.map((asset) => asset.id),
    `${options.seed}:${DEFAULT_RECIPE_SEED_SUFFIX}`,
    coverageMin,
    coverageMax,
  );

  const baseAssetById = new Map(baseAssets.map((asset) => [asset.id, asset]));
  const existingDerivedKeys = new Set(
    generatedManifest.assets
      .filter(
        (asset) =>
          asset.synthetic?.source === 'generated' && asset.synthetic.variantKind === 'derived',
      )
      .map(
        (asset) =>
          `${asset.synthetic?.recipeId ?? 'unknown'}:${asset.synthetic?.parentAssetIds?.[0] ?? 'none'}`,
      ),
  );

  const nextAssets = [...generatedManifest.assets];
  const seenAssetIds = new Set(nextAssets.map((asset) => asset.id));
  const tempDir = path.join(options.repoRoot, 'corpus', 'generated', '.tmp');
  await mkdir(tempDir, { recursive: true });

  for (const assignment of assignments) {
    const recipeKey = `${assignment.recipe.id}:${assignment.baseAssetId}`;
    if (existingDerivedKeys.has(recipeKey)) {
      continue;
    }

    const baseAsset = baseAssetById.get(assignment.baseAssetId);
    if (!baseAsset?.synthetic) continue;

    const basePath = path.join(options.repoRoot, 'corpus', 'generated', baseAsset.relativePath);
    const background = baseAsset.synthetic.appearance.bgColor;
    let currentPath = basePath;
    const tempPaths: string[] = [];
    let resolvedBackgroundAsset = undefined as
      | { readonly id: string; readonly relativePath: string }
      | undefined;

    try {
      for (let stepIndex = 0; stepIndex < assignment.recipe.steps.length; stepIndex += 1) {
        const step = assignment.recipe.steps[stepIndex]!;
        const nextPath = withTempPath(tempDir, `${assignment.recipe.id}-${stepIndex}`);
        tempPaths.push(nextPath);

        if (step.kind === 'background-blend') {
          const backgroundAsset = backgroundChoice(
            negativeAssets,
            `${options.seed}:${assignment.recipe.id}:${assignment.baseAssetId}:${stepIndex}`,
          );
          resolvedBackgroundAsset = {
            id: backgroundAsset.id,
            relativePath: backgroundAsset.relativePath,
          };
          await applyRecipeStep({
            inputPath: currentPath,
            outputPath: nextPath,
            step,
            background,
            pixelSize: baseAsset.synthetic.appearance.pixelSize,
            backgroundAssetPath: path.join(
              options.repoRoot,
              'corpus',
              'data',
              backgroundAsset.relativePath,
            ),
          });
        } else {
          await applyRecipeStep({
            inputPath: currentPath,
            outputPath: nextPath,
            step,
            background,
            pixelSize: baseAsset.synthetic.appearance.pixelSize,
          });
        }
        currentPath = nextPath;
      }

      const syntheticTransformations = assignment.recipe.steps.map((step) => ({
        ...step,
        recipeId: assignment.recipe.id,
        ...(step.kind === 'background-blend' && resolvedBackgroundAsset
          ? {
              backgroundAssetId: resolvedBackgroundAsset.id,
              backgroundAssetPath: resolvedBackgroundAsset.relativePath,
            }
          : {}),
      }));

      const asset = await buildGeneratedAssetRecord({
        repoRoot: options.repoRoot,
        outputPath: currentPath,
        label: 'qr-pos',
        provenance: [
          buildLocalGeneratedProvenance(basePath, `Derived from ${assignment.baseAssetId}`),
          ...(resolvedBackgroundAsset
            ? [
                buildLocalGeneratedProvenance(
                  path.join(
                    options.repoRoot,
                    'corpus',
                    'data',
                    resolvedBackgroundAsset.relativePath,
                  ),
                  `Blended with approved negative ${resolvedBackgroundAsset.id}`,
                ),
              ]
            : []),
        ],
        review: {
          status: 'approved',
          reviewer: GENERATED_REVIEWER,
          reviewedAt: new Date().toISOString(),
          notes: 'Synthetic derived asset',
        },
        groundTruth: baseAsset.groundTruth ?? {
          qrCount: 1,
          codes: [{ text: baseAsset.synthetic.encodedData, kind: baseAsset.synthetic.payloadType }],
        },
        synthetic: {
          ...baseAsset.synthetic,
          variantKind: 'derived',
          seed: `${options.seed}:${DEFAULT_RECIPE_SEED_SUFFIX}`,
          recipeId: assignment.recipe.id,
          parentAssetIds: [baseAsset.id],
          transformations: syntheticTransformations,
          appearance: {
            ...baseAsset.synthetic.appearance,
            quietZoneModules:
              baseAsset.synthetic.appearance.quietZoneModules ?? DEFAULT_BASE_QUIET_ZONE_MODULES,
          },
        },
      });

      if (seenAssetIds.has(asset.id)) {
        existingDerivedKeys.add(recipeKey);
        continue;
      }

      nextAssets.push(asset);
      seenAssetIds.add(asset.id);
      existingDerivedKeys.add(recipeKey);
    } finally {
      await Promise.all(tempPaths.map((tempPath) => rm(tempPath, { force: true })));
    }
  }

  await writeGeneratedCorpusManifest(options.repoRoot, {
    version: generatedManifest.version,
    assets: nextAssets,
  });
};

await main();
