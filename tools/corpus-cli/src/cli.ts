import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { runApp } from './app.js';
import {
  getCorpusCliConfigPath,
  readViewerPreference,
  type ViewerPreference,
  writeViewerPreference,
} from './config.js';
import { resolveRepoRootFromModuleUrl } from './repo-root.js';
import { isInteractiveSession } from './tty.js';
import { createClackUi } from './ui/clack.js';
import { CliCancelledError, type CliUi, type SelectOption } from './ui.js';

const detectGithubLogin = (): string | undefined => {
  try {
    const login = execFileSync('gh', ['api', 'user', '--jq', '.login'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return login || undefined;
  } catch (error) {
    if (error instanceof Error && ('status' in error || 'code' in error)) {
      return undefined;
    }
    console.warn('detectGithubLogin: unexpected error:', error);
    return undefined;
  }
};

type OpenTargetInvocation = {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: {
    readonly stdio: 'ignore';
    readonly detached: true;
  };
};

const defaultViewerPreference: ViewerPreference = { mode: 'default' };

const normalizeHttpTarget = (target: string): string => {
  const url = new URL(target);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Expected http(s) URL, got ${url.protocol}`);
  }

  return url.toString();
};

const isPathLike = (value: string): boolean => {
  return value.includes(path.sep) || value.includes('/') || /^[A-Za-z]:\\/.test(value);
};

/**
 * Build a spawn invocation to open a local file target in the appropriate viewer.
 * @param platform Defaults to `process.platform`; override in tests.
 */
export const buildOpenTargetInvocation = (
  target: string,
  platform: NodeJS.Platform = process.platform,
  viewer: ViewerPreference = defaultViewerPreference,
): OpenTargetInvocation => {
  const options = { stdio: 'ignore' as const, detached: true as const };

  if (platform === 'darwin') {
    if (viewer.mode === 'quicklook') {
      return {
        command: 'qlmanage',
        args: ['-p', target],
        options,
      };
    }

    if (viewer.mode === 'preview') {
      return {
        command: 'open',
        args: ['-g', '-a', 'Preview', target],
        options,
      };
    }

    if (viewer.mode === 'custom-app') {
      return isPathLike(viewer.value)
        ? {
            command: path.resolve(viewer.value),
            args: [target],
            options,
          }
        : {
            command: 'open',
            args: ['-g', '-a', viewer.value, target],
            options,
          };
    }

    return {
      command: 'open',
      args: ['-g', target],
      options,
    };
  }

  if (platform === 'win32') {
    if (viewer.mode === 'custom-app') {
      return {
        command: path.resolve(viewer.value),
        args: [target],
        options,
      };
    }

    return {
      command: 'explorer.exe',
      args: [target],
      options,
    };
  }

  if (viewer.mode === 'custom-app') {
    return {
      command: isPathLike(viewer.value) ? path.resolve(viewer.value) : viewer.value,
      args: [target],
      options,
    };
  }

  return {
    command: 'xdg-open',
    args: [target],
    options,
  };
};

/**
 * Build a spawn invocation to open an HTTP/HTTPS URL in the system browser.
 * @param platform Defaults to `process.platform`; override in tests.
 */
export const buildOpenExternalInvocation = (
  target: string,
  platform: NodeJS.Platform = process.platform,
): OpenTargetInvocation => {
  const options = { stdio: 'ignore' as const, detached: true as const };
  const normalizedTarget = normalizeHttpTarget(target);

  if (platform === 'darwin') {
    return {
      command: 'open',
      args: ['-g', normalizedTarget],
      options,
    };
  }

  if (platform === 'win32') {
    return {
      command: 'explorer.exe',
      args: [normalizedTarget],
      options,
    };
  }

  return {
    command: 'xdg-open',
    args: [normalizedTarget],
    options,
  };
};

const openInvocation = (invocation: OpenTargetInvocation): Promise<void> => {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, invocation.options);

    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
};

const resolveViewerFromSelect = async (
  ui: CliUi,
  selectMessage: string,
  initialValue: string,
  options: readonly SelectOption<string>[],
  customMessage: string,
  customPlaceholder: string,
  customRequired: string,
): Promise<ViewerPreference> => {
  const choice = await ui.select({ message: selectMessage, initialValue, options });
  if (choice === 'custom-app') {
    const value = (
      await ui.text({
        message: customMessage,
        placeholder: customPlaceholder,
        validate: (input) => (input.trim().length > 0 ? undefined : customRequired),
      })
    ).trim();
    return { mode: 'custom-app', value };
  }
  return { mode: choice as Exclude<ViewerPreference['mode'], 'custom-app'> };
};

const promptViewerPreference = async (
  ui: CliUi,
  repoRoot: string,
  platform: NodeJS.Platform = process.platform,
): Promise<ViewerPreference> => {
  const saved = await readViewerPreference(repoRoot);
  if (saved) {
    return saved;
  }

  if (!isInteractiveSession()) {
    return defaultViewerPreference;
  }

  let viewer: ViewerPreference;

  if (platform === 'darwin') {
    viewer = await resolveViewerFromSelect(
      ui,
      'Running on macOS. Which app should preview images?',
      'quicklook',
      [
        { value: 'quicklook', label: 'Quick Look', hint: 'reuses one viewer nicely' },
        { value: 'preview', label: 'Preview', hint: 'opens in background, keeps terminal focus' },
        { value: 'default', label: 'Default app' },
        { value: 'custom-app', label: 'Custom app…' },
      ],
      'App name or app path',
      'Preview or /Applications/Preview.app',
      'App is required',
    );
  } else if (platform === 'win32') {
    viewer = await resolveViewerFromSelect(
      ui,
      'Running on Windows. Which app should preview images?',
      'default',
      [
        { value: 'default', label: 'Default app' },
        { value: 'custom-app', label: 'Custom app path…' },
      ],
      'App path',
      'C:\\Program Files\\ImageGlass\\ImageGlass.exe',
      'App path is required',
    );
  } else {
    viewer = await resolveViewerFromSelect(
      ui,
      'Which app should preview images?',
      'default',
      [
        { value: 'default', label: 'Default app' },
        { value: 'custom-app', label: 'Custom app command…' },
      ],
      'App command or path',
      'sxiv',
      'App command is required',
    );
  }

  await writeViewerPreference(repoRoot, viewer);
  ui.info(
    `Saved image viewer preference to ${path.relative(repoRoot, getCorpusCliConfigPath(repoRoot))}`,
  );
  return viewer;
};

const createImageOpeners = (
  ui: CliUi,
  repoRoot: string,
  platform: NodeJS.Platform = process.platform,
) => {
  let viewerPromise: Promise<ViewerPreference> | undefined;

  const ensureImageViewer = async (): Promise<void> => {
    viewerPromise ??= promptViewerPreference(ui, repoRoot, platform);
    await viewerPromise;
  };

  const openImage = async (target: string): Promise<void> => {
    viewerPromise ??= promptViewerPreference(ui, repoRoot, platform);
    const viewer = await viewerPromise;
    await openInvocation(buildOpenTargetInvocation(target, platform, viewer));
  };

  return {
    ensureImageViewer,
    openImage,
  };
};

const createOpenExternal = (platform: NodeJS.Platform = process.platform) => {
  return async (target: string): Promise<void> => {
    await openInvocation(buildOpenExternalInvocation(target, platform));
  };
};

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const verbose = argv.includes('--verbose') || argv.includes('-v');
  const ui = createClackUi({ verbose });
  const repoRoot = resolveRepoRootFromModuleUrl(import.meta.url);
  const { ensureImageViewer, openImage } = createImageOpeners(ui, repoRoot);

  try {
    await runApp(
      {
        repoRoot,
        ui,
        ensureImageViewer,
        openImage,
        openExternal: createOpenExternal(),
        detectGithubLogin,
      },
      argv,
    );
  } catch (error) {
    if (error instanceof CliCancelledError) {
      ui.cancel('Cancelled');
      return;
    }

    if (!verbose) {
      ui.warn('Run again with --verbose for scrape details');
    }
    throw error;
  }
};

if (import.meta.main) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
