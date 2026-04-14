import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AppContext } from '../context.js';
import { detectQrKind } from '../qr-kind.js';
import type { AutoScan, CorpusAssetLabel, GroundTruth, ReviewStatus } from '../schema.js';
import { assertInteractiveSession } from '../tty.js';
import type { CliUi } from '../ui.js';

export const splitUrlInput = (value: string): string[] => {
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

export const splitPathInput = (value: string): string[] => {
  return value
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

export const promptLabel = async (
  ui: CliUi,
  initialValue: CorpusAssetLabel = 'qr-positive',
): Promise<CorpusAssetLabel> => {
  assertInteractiveSession('Label required in non-interactive mode');
  return ui.select({
    message: 'Asset label',
    initialValue,
    options: [
      { value: 'qr-positive', label: 'qr-positive', hint: 'image contains at least one QR code' },
      {
        value: 'non-qr-negative',
        label: 'non-qr-negative',
        hint: 'image should not decode as QR',
      },
    ],
  });
};

export const promptReviewStatus = async (
  ui: CliUi,
  initialValue: ReviewStatus = 'approved',
): Promise<ReviewStatus> => {
  assertInteractiveSession('Review status required in non-interactive mode');
  return ui.select({
    message: 'Review status',
    initialValue,
    options: [
      { value: 'approved', label: 'approved', hint: 'ready for corpus use' },
      { value: 'pending', label: 'pending', hint: 'import now, review later' },
      { value: 'rejected', label: 'rejected', hint: 'keep record, exclude from corpus use' },
    ],
  });
};

export const promptOptionalText = async (
  ui: CliUi,
  message: string,
  initialValue?: string,
): Promise<string | undefined> => {
  const rawValue = await ui.text({
    message,
    ...(initialValue ? { initialValue } : {}),
  });
  const trimmed = (typeof rawValue === 'string' ? rawValue : '').trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const resolveReviewer = async (
  context: Pick<AppContext, 'detectGithubLogin' | 'ui'>,
  explicitReviewer?: string,
): Promise<string> => {
  if (explicitReviewer) {
    return explicitReviewer;
  }

  assertInteractiveSession('Reviewer required in non-interactive mode');

  const detected = context.detectGithubLogin();
  const reviewer = (
    await context.ui.text({
      message: 'Reviewer GitHub username',
      ...(detected ? { initialValue: detected } : {}),
      validate: (value) => (value.trim().length > 0 ? undefined : 'Reviewer is required'),
    })
  ).trim();

  return reviewer || detected || '';
};

const getStageRoot = (repoRoot: string): string => {
  return path.join(repoRoot, 'corpus', 'staging');
};

export const listStageDirectories = async (repoRoot: string): Promise<readonly string[]> => {
  try {
    const entries = await readdir(getStageRoot(repoRoot), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(getStageRoot(repoRoot), entry.name))
      .sort((left, right) => right.localeCompare(left));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  }
};

export const isLikelyStageDir = async (targetPath: string): Promise<boolean> => {
  try {
    const absolutePath = path.resolve(targetPath);
    const stats = await stat(absolutePath);
    if (!stats.isDirectory()) {
      return false;
    }

    const entries = await readdir(absolutePath, { withFileTypes: true });
    return entries.some((entry) => entry.isDirectory());
  } catch {
    return false;
  }
};

export const promptStageDir = async (
  context: Pick<AppContext, 'repoRoot' | 'ui'>,
  explicitStageDir?: string,
): Promise<string> => {
  if (explicitStageDir) {
    return path.resolve(explicitStageDir);
  }

  const stageDirs = await listStageDirectories(context.repoRoot);
  if (stageDirs.length === 0) {
    assertInteractiveSession('Stage dir required in non-interactive mode');
    return path.resolve(
      await context.ui.text({
        message: 'Stage directory',
        placeholder: 'corpus/staging/<run-id>',
        validate: (value) => (value.trim().length > 0 ? undefined : 'Stage dir is required'),
      }),
    );
  }

  assertInteractiveSession('Stage dir required in non-interactive mode');
  return context.ui.select({
    message: 'Choose staged scrape run',
    options: stageDirs.map((stageDir) => ({
      value: stageDir,
      label: path.relative(context.repoRoot, stageDir),
    })),
  });
};

export const promptLocalPaths = async (
  ui: CliUi,
  initialPaths: readonly string[] = [],
): Promise<readonly string[]> => {
  assertInteractiveSession('Local file path required in non-interactive mode');

  const initialValue = initialPaths.join(', ');
  const value = await ui.text({
    message: 'Local image path(s), separated by commas or newlines',
    ...(initialValue ? { initialValue } : {}),
    validate: (input) =>
      splitPathInput(input).length > 0 ? undefined : 'At least one path is required',
  });
  return splitPathInput(value).map((entry) => path.resolve(entry));
};

export const promptQrCount = async (
  ui: CliUi,
  message = 'How many QR codes are present?',
  initialValue?: number,
): Promise<number> => {
  assertInteractiveSession('QR count required in non-interactive mode');
  const value = await ui.text({
    message,
    ...(initialValue !== undefined ? { initialValue: String(initialValue) } : {}),
    validate: (input) => {
      if (input.trim().length === 0) {
        return 'QR count is required';
      }

      const qrCount = Number(input);
      return Number.isInteger(qrCount) && qrCount >= 0 ? undefined : 'Enter a whole number ≥ 0';
    },
  });

  return Number(value);
};

export const promptManualGroundTruth = async (
  ui: CliUi,
  qrCount: number,
  prefills: ReadonlyArray<{ readonly text?: string; readonly kind?: string }> = [],
): Promise<GroundTruth> => {
  assertInteractiveSession('Ground truth required in non-interactive mode');
  const codes: Array<GroundTruth['codes'][number]> = [];

  for (let index = 0; index < qrCount; index += 1) {
    const label = index + 1;
    const prefill = prefills[index];

    const text = await ui.text({
      message: `QR #${label} data (Enter newline, Esc then Enter submit)`,
      multiline: true,
      ...(prefill?.text ? { initialValue: prefill.text } : {}),
      validate: (value) => (value.trim().length > 0 ? undefined : 'QR data is required'),
    });
    const autoKind = detectQrKind(text);
    const kind = await promptOptionalText(
      ui,
      `QR #${label} kind (optional)`,
      prefill?.kind ?? autoKind,
    );
    const verifiedWith = await promptOptionalText(ui, `QR #${label} verified with (optional)`);

    codes.push({
      text,
      ...(kind ? { kind } : {}),
      ...(verifiedWith ? { verifiedWith } : {}),
    });
  }

  return { qrCount, codes };
};

export const buildAutoScanGroundTruth = (
  autoScan: AutoScan,
  qrCount: number,
): GroundTruth | undefined => {
  if (!autoScan.succeeded || autoScan.results.length !== qrCount) {
    return undefined;
  }

  return {
    qrCount,
    codes: autoScan.results.map((result) => ({
      text: result.text,
      ...(result.kind ? { kind: result.kind } : {}),
    })),
  };
};
