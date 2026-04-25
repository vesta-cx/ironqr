import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import type { CorpusAsset } from '../schema.js';
import { getGeneratedCorpusAssetsRoot } from './manifest.js';
import type { BaseAppearanceSpec, GeneratedPayloadTemplate, ThemeColors } from './spec.js';

const DEFAULT_QR_PROJECT_ROOT = path.join(process.env.HOME ?? '', 'Development', 'mia-cx', 'qr');
const LOCAL_GENERATOR_ATTRIBUTION = 'self-generated';

export interface QrProjectBindings {
  readonly generateQRSvg: (options: {
    readonly data: string;
    readonly errorCorrection: string;
    readonly pixelSize: number;
    readonly moduleStyle: string;
    readonly capStyle: string;
    readonly connectionMode: string;
    readonly dotSize: number;
    readonly fgColor: string;
    readonly bgColor: string;
    readonly frameText?: string;
  }) => string;
  readonly encodePayload: (
    type: GeneratedPayloadTemplate['type'],
    fields: GeneratedPayloadTemplate['fields'],
  ) => string;
  readonly themes: readonly ThemeColors[];
  readonly getMinimumPixelPerfectDotSize: (pixelSize: number) => number;
  readonly normalizeDotSize: (dotSize: number, pixelSize: number) => number;
  readonly normalizeCapStyle: (capStyle: string, pixelSize: number) => string;
}

export interface ScriptOptions {
  readonly repoRoot: string;
  readonly qrProjectRoot: string;
  readonly seed: string;
}

export const hashSha256 = (buffer: Uint8Array): string => {
  return createHash('sha256').update(buffer).digest('hex');
};

export const getDefaultQrProjectRoot = (): string => DEFAULT_QR_PROJECT_ROOT;

export const importQrProjectBindings = async (
  qrProjectRoot: string,
): Promise<QrProjectBindings> => {
  const generateMod = await import(
    pathToFileURL(path.join(qrProjectRoot, 'src/lib/qr/generate.ts')).href
  );
  const payloadsMod = await import(
    pathToFileURL(path.join(qrProjectRoot, 'src/lib/qr/payloads.ts')).href
  );
  const themesMod = await import(
    pathToFileURL(path.join(qrProjectRoot, 'src/lib/themes/index.ts')).href
  );

  return {
    generateQRSvg: generateMod.generateQRSvg,
    encodePayload: payloadsMod.encodePayload,
    themes: themesMod.themes,
    getMinimumPixelPerfectDotSize: generateMod.getMinimumPixelPerfectDotSize,
    normalizeDotSize: generateMod.normalizeDotSize,
    normalizeCapStyle: generateMod.normalizeCapStyle,
  };
};

export const parseScriptOptions = (argv: readonly string[]): ScriptOptions => {
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token || !token.startsWith('--')) continue;
    const name = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Expected value after --${name}`);
    }
    options.set(name, value);
    index += 1;
  }

  return {
    repoRoot: path.resolve(
      options.get('repo-root') ?? path.join(import.meta.dir, '..', '..', '..', '..'),
    ),
    qrProjectRoot: path.resolve(options.get('qr-project-root') ?? getDefaultQrProjectRoot()),
    seed: options.get('seed') ?? 'generated-corpus-v1',
  };
};

export const parseNumberFlag = (
  argv: readonly string[],
  flag: string,
  fallback: number,
): number => {
  const index = argv.indexOf(`--${flag}`);
  if (index === -1) return fallback;
  const raw = argv[index + 1];
  const parsed = Number(raw);
  if (!raw || !Number.isFinite(parsed)) {
    throw new Error(`Expected numeric value for --${flag}`);
  }
  return parsed;
};

export const parseStringFlag = (
  argv: readonly string[],
  flag: string,
  fallback?: string,
): string | undefined => {
  const index = argv.indexOf(`--${flag}`);
  if (index === -1) return fallback;
  const raw = argv[index + 1];
  if (!raw || raw.startsWith('--')) {
    throw new Error(`Expected value for --${flag}`);
  }
  return raw;
};

export const hasFlag = (argv: readonly string[], flag: string): boolean =>
  argv.includes(`--${flag}`);

export const ensureParentDir = async (targetPath: string): Promise<void> => {
  await mkdir(path.dirname(targetPath), { recursive: true });
};

export const ensureCommandAvailable = async (command: string): Promise<void> => {
  await runCommand('which', [command], { quiet: true });
};

export const runCommand = async (
  command: string,
  args: readonly string[],
  options: { readonly quiet?: boolean; readonly input?: string } = {},
): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', options.quiet ? 'ignore' : 'inherit', options.quiet ? 'ignore' : 'inherit'],
    });

    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? 'unknown'}`));
    });

    if (options.input !== undefined) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
};

export const renderQrSvgToPng = async (svg: string, outputPath: string): Promise<void> => {
  const tempSvgPath = `${outputPath}.svg`;
  await ensureParentDir(outputPath);
  await writeFile(tempSvgPath, svg, 'utf8');
  try {
    try {
      await runCommand('magick', [tempSvgPath, outputPath], { quiet: true });
    } catch {
      await sharp(Buffer.from(svg, 'utf8')).png().toFile(outputPath);
    }
  } finally {
    await rm(tempSvgPath, { force: true });
  }
};

export const getFileInfo = async (
  filePath: string,
): Promise<{
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
}> => {
  const bytes = new Uint8Array(await readFile(filePath));
  const metadata = await sharp(bytes).metadata();
  return {
    bytes,
    sha256: hashSha256(bytes),
    byteLength: bytes.byteLength,
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
  };
};

export const buildGeneratedAssetId = (sha256: string): string => `generated-${sha256.slice(0, 16)}`;

export const getGeneratedAssetPath = (
  repoRoot: string,
  assetId: string,
  extension = '.png',
): string => path.join(getGeneratedCorpusAssetsRoot(repoRoot), `${assetId}${extension}`);

export const buildGeneratedAssetRecord = async (options: {
  readonly repoRoot: string;
  readonly outputPath: string;
  readonly label: 'qr-pos' | 'qr-neg';
  readonly provenance: CorpusAsset['provenance'];
  readonly review: CorpusAsset['review'];
  readonly groundTruth: NonNullable<CorpusAsset['groundTruth']>;
  readonly synthetic: NonNullable<CorpusAsset['synthetic']>;
}): Promise<CorpusAsset> => {
  const info = await getFileInfo(options.outputPath);
  const assetId = buildGeneratedAssetId(info.sha256);
  const assetPath = getGeneratedAssetPath(options.repoRoot, assetId);

  if (path.resolve(assetPath) !== path.resolve(options.outputPath)) {
    await ensureParentDir(assetPath);
    await writeFile(assetPath, info.bytes);
  }

  return {
    id: assetId,
    label: options.label,
    mediaType: 'image/png',
    fileExtension: '.png',
    relativePath: path
      .relative(path.join(options.repoRoot, 'corpus', 'generated'), assetPath)
      .replaceAll('\\', '/'),
    sha256: info.sha256,
    byteLength: info.byteLength,
    sourceSha256: info.sha256,
    provenance: options.provenance,
    review: options.review,
    groundTruth: options.groundTruth,
    synthetic: options.synthetic,
  };
};

export const buildLocalGeneratedProvenance = (
  originalPath: string,
  notes: string,
): CorpusAsset['provenance'][number] => ({
  kind: 'local',
  originalPath,
  importedAt: new Date().toISOString(),
  attribution: LOCAL_GENERATOR_ATTRIBUTION,
  notes,
});

export const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
};
