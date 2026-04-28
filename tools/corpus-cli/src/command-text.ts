/** Build the preferred root-script command string for help text and follow-up hints. */
export const buildFilteredCliCommand = (command?: string, args: readonly string[] = []): string => {
  const prefix = commandToRootScript(command);
  const renderedArgs = args.map((value) => JSON.stringify(value)).join(' ');
  return renderedArgs.length > 0 ? `${prefix} ${renderedArgs}` : prefix;
};

const commandToRootScript = (command?: string): string => {
  if (!command) return 'bun run corpus';
  if (command === 'scrape') return 'bun run corpus:scrape';
  if (command === 'review') return 'bun run corpus:review';
  if (command === 'import') return 'bun run corpus:import';
  if (command === 'build-bench') return 'bun run corpus:build-bench';
  if (command === 'scan-corpus') return 'bun run corpus:scan';
  return `bun run --cwd tools/corpus-cli corpus ${command}`;
};

/** Return the full CLI usage/help text shown when no valid subcommand is found. */
export const getUsageText = (): string => {
  return `Usage:
  ${buildFilteredCliCommand()}
  ${buildFilteredCliCommand('scrape')} [--limit 25] [--source commons|pixabay-api] [--query "qr code"] [<seed-urls...>]
  ${buildFilteredCliCommand('review')} [<stage-dir>] [--reviewer github-login]
  ${buildFilteredCliCommand('import')} [<files...>|<stage-dir>] [--label qr-pos|qr-neg] [--review pending|approved|rejected]
  ${buildFilteredCliCommand('build-bench')} [<asset-id...>]
  ${buildFilteredCliCommand('scan-corpus')} [--label qr-pos|qr-neg] [--failures-only] [--quiet]

Global flags:
  --verbose / -v    log skipped candidates, same-host redirects, and other scrape details

Notes:
  - no subcommand = guided scrape → review → import flow
  - missing required args prompt in TTY sessions
  - interactive scrape prompts can pick Wikimedia Commons, Pixabay API, or custom seed URLs
  - build-bench writes committed perfbench fixture under tools/perfbench/fixtures/real-world/
  - scan-corpus runs the production scanner against every approved corpus asset and reports decode/false-positive rates`;
};
