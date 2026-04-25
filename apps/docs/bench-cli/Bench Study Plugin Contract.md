# Bench Study Plugin Contract

Related: [[View Study]], [[Diagnostics and Benchmark Boundary]], [[Pipeline Stage Contracts]]

## Purpose
Define a small plugin contract for `tools/bench` study tooling.

A **study** is an offline experiment that asks a corpus-scale question about scanner behavior. Examples:
- Which proposal views should run first?
- Which cluster representatives should receive decode budget?
- Which early-exit thresholds reject false positives without killing positives?
- Which decode-rescue path pays for itself?

The contract should make these studies easy to add without turning the bench CLI into a pile of one-off scripts.

## Non-goals
This is not a public `ironqr` runtime plugin API.

Avoid:
- loading arbitrary third-party packages by name
- exposing internal pipeline stage reordering as a public product promise
- ungated observability that adds production scan cost
- one-off benchmark hooks inside `packages/ironqr` that are not useful for consumer tuning or debugging
- a generic workflow engine
- a full declarative experiment DSL before we have 3+ real studies

## Design principles

### Studies are bench consumers
`tools/bench` consumes `ironqr` exports and diagnostics. It should not own scanner architecture.

If a study needs scanner evidence, prefer:
- exported stage functions
- typed trace events
- typed summaries

Extra observability, metadata, and metrics are worth adding to `ironqr` when they help study tooling or consumer tuning. Gate them behind explicit options so production scans do not pay for unused collection.

Avoid benchmark-only flags whose semantics are tied to one script. Prefer general-purpose options such as trace level, metrics collection, proposal metadata, or debug summaries that can also serve tests, local debugging, and advanced users tuning scanner policy.

### Contracts over scripts
Each study should have the same shape:
- metadata
- flags
- corpus selection
- resumable cache policy
- execution
- report output
- summary output

The internals can be bespoke. The outer shell should be boring.

### Stable artifacts
Study outputs should be easy to compare across branches and over time.

Reports must record:
- study plugin id and version
- repo commit if available
- corpus manifest hash or asset ids
- selected flags
- generated-at timestamp
- summary metrics
- detailed rows needed to reproduce conclusions

### Caches are implementation details
A study may keep resumable cache state, but report JSON is the review artifact.

Cache files may change shape when a plugin version changes. Report shape should be more stable.

## Proposed CLI shape

```sh
bun run bench study list
bun run bench study --list
bun run bench study view-proposals
bun run bench study view-proposals --max-assets 25 --refresh-cache
bun run bench study view-proposals --asset asset-123 --asset asset-456
bun run bench study view-proposals --report-file tools/bench/reports/view-study.json
```

`view-order` is kept as a compatibility alias for `view-proposals`.

Bench already has shared concepts that should carry into study mode where they make sense: cache refresh, OpenTUI progress, worker limits, report paths, and corpus filters. A study does not have to use every shared option, but unsupported shared options should fail clearly instead of being silently ignored.

Do not add `--engine` to study mode by default. Engine selection is useful for accuracy benchmarking, but most studies should consume cached accuracy results or first-party `ironqr` diagnostics instead of rerunning arbitrary engine subsets. If a future study truly needs engine-backed execution, make that a plugin-specific flag with a clear reason.

Top-level flags shared by all studies:

| Flag | Meaning |
| --- | --- |
| `--list` | Print registered studies and exit. |
| `--asset <id>` | Restrict to explicit approved corpus asset ids. Repeatable. |
| `--label qr-pos\|qr-neg` | Restrict corpus label. Repeatable. |
| `--max-assets <n>` | Cap selected assets after filters. Useful for smoke tests. |
| `--report-file <path>` | Override report output path. |
| `--cache-file <path>` | Override cache path. |
| `--no-cache` | Disable plugin cache reads and writes. |
| `--refresh-cache` | Ignore cache reads but write fresh cache entries. Applies to plugin cache and any shared engine cache the study uses. |
| `--no-progress` | Disable OpenTUI progress rendering for non-interactive logs. |
| `--workers <n>` | Bound concurrent asset work when the plugin supports it. |
| `--plugin-flag=value` | Study-specific flags declared by plugin metadata. |

Recommended default paths:

```txt
tools/bench/reports/study-<plugin-id>.json
tools/bench/reports/runs/<timestamp>-<short-sha>/study-<plugin-id>.json
tools/bench/.cache/studies/<plugin-id>.json
```

Use simple filesystem-safe plugin ids. There is no need for namespacing while bench studies are only for `ironqr`.

## Contract sketch

```ts
export type StudyPluginId = string;

export interface StudyPlugin<Summary extends object, Config extends object, AssetResult> {
  readonly id: StudyPluginId;
  readonly title: string;
  readonly description: string;
  readonly version: string;
  readonly flags?: readonly StudyPluginFlag[];

  parseConfig?(context: StudyConfigContext): Config;
  cacheKey?(config: Config): string;
  runAsset?(input: StudyAssetInput<Config>): Promise<AssetResult>;
  summarize?(input: StudySummaryInput<Config, AssetResult>): Summary;
  renderReport?(input: StudySummaryInput<Config, AssetResult> & { readonly summary: Summary }): unknown;
  engines?(config: Config): readonly AccuracyEngineDescriptor[];
  observability?(config: Config): Record<string, unknown>;

  // Escape hatch for experiments that must own their full execution loop.
  run?(context: StudyPluginContext): Promise<StudyPluginResult<Summary>>;
}

export interface StudyPluginFlag {
  readonly name: string;
  readonly type: 'string' | 'number' | 'boolean' | 'string-list';
  readonly description: string;
  readonly default?: string | number | boolean | readonly string[];
}

export interface StudyPluginContext {
  readonly repoRoot: string;
  readonly assets: readonly CorpusBenchAsset[];
  readonly output: StudyOutputPaths;
  readonly flags: Readonly<Record<string, StudyFlagValue>>;
  readonly reports: {
    accuracy(): Promise<unknown | null>;
    performance(): Promise<unknown | null>;
  };
  readonly cache: StudyCache;
  readonly signal?: AbortSignal;
  readonly log: (message: string) => void;
}

export interface StudyPluginResult<Summary extends object = Record<string, unknown>> {
  readonly pluginId: StudyPluginId;
  readonly pluginVersion: string;
  readonly assetCount: number;
  readonly summary: Summary;
  readonly report: unknown;
}
```

The first implementation can be smaller than this sketch. The important boundary is that every plugin receives selected corpus assets and writes a structured result through the same runner.

## Corpus asset contract
Studies should use the same approved corpus view as `bench accuracy`, not re-read manifests ad hoc.

Target asset shape:

```ts
export interface CorpusBenchAsset {
  readonly id: string;
  readonly label: 'qr-pos' | 'qr-neg';
  readonly sha256: string;
  readonly imagePath: string;
  readonly relativePath: string;
  readonly expectedTexts: readonly string[];
  readonly loadImage: () => Promise<BenchImageData>;
}
```

This gives studies enough information to:
- run scanner stages
- score positive/negative behavior
- build reproducible cache keys
- print readable reports

## Cache contract
Keep the cache API deliberately tiny:

```ts
export interface StudyCache {
  read<T>(key: StudyCacheKey): T | null;
  write<T>(key: StudyCacheKey, value: T): Promise<void>;
  delete(key: StudyCacheKey): Promise<void>;
}

export interface StudyCacheKey {
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly assetId: string;
  readonly assetSha256: string;
  readonly operation: string;
  readonly flagsHash: string;
}
```

Plugins own cached value schemas. The shared runner owns invalidation dimensions:
- plugin id
- plugin version
- plugin config/cache key
- asset id
- asset hash
- engine id/version metadata declared by the plugin
- scanner observability metadata declared by the plugin

## Report envelope
The shared runner should wrap plugin reports in a common envelope:

```ts
export interface StudyReportEnvelope {
  readonly kind: 'bench-study-report';
  readonly schemaVersion: 1;
  readonly plugin: {
    readonly id: string;
    readonly title: string;
    readonly version: string;
  };
  readonly generatedAt: string;
  readonly repo: {
    readonly root: string;
    readonly commit: string | null;
    readonly dirty: boolean | null;
  };
  readonly corpus: {
    readonly assetCount: number;
    readonly positiveCount: number;
    readonly negativeCount: number;
    readonly assetIds: readonly string[];
  };
  readonly flags: Readonly<Record<string, StudyFlagValue>>;
  readonly summary: object;
  readonly report: unknown;
}
```

This keeps plugin-specific detail flexible while making every report discoverable and diffable.

## Registry model
Start with static in-repo registration:

```ts
const studyPlugins = createStudyPluginRegistry([
  { plugin: viewProposalsStudyPlugin },
  { plugin: viewOrderStudyPlugin }, // compatibility alias
]);
```

Do not add dynamic external loading yet. In-repo static registration is enough for current needs and keeps typechecking straightforward.

Future external loading can be added only if there is a real need for studies outside this repo.

## First plugin target: `view-proposals`
This plugin replaces the current one-off view study shape. `view-order` remains as a compatibility alias.

It should answer:
- Which binary views generate useful proposals?
- Which views produce first winners?
- Which views mostly create false-positive or expensive tail work?
- Which ordered proposal-view allowlist should be considered for production?

Study-specific flags could include:

| Flag | Type | Meaning |
| --- | --- | --- |
| `view` | string-list | Restrict to explicit binary view ids. |
| `top-k` | number | Emit top K recommended views. |
| `max-proposals-per-asset` | number | Bound per-asset proposal work. |
| `trace` | boolean | Store full trace excerpts for failed or surprising assets. |

## Implementation slices

### Slice 1 — contract and docs
- Add this design note.
- Add exported TypeScript types for the study contract.
- Add registry with duplicate-id validation.
- Add unit tests for registration and context typing.

### Slice 2 — corpus selection shared by accuracy and study
- Extract approved corpus loading from `accuracy/runner.ts` into a shared module.
- Return `CorpusBenchAsset[]` with lazy image loading.
- Keep `bench accuracy` behavior unchanged.

### Slice 3 — study CLI shell
- Add `bench study list` and `bench study --list`.
- Add `bench study <plugin-id>` lookup.
- Parse shared study flags.
- Parse plugin-declared flags such as `--preset` and `--top-k`.
- Write report envelope.

### Slice 4 — cache and OpenTUI progress
- Add JSON cache store keyed by plugin/version/asset/config/engine/observability.
- Use OpenTUI as the progress UI. Support `--no-progress` for CI and log-only runs.
- Keep plugin progress API minimal.

Current study OpenTUI behavior:

- Study mode renders study-specific panels instead of accuracy widgets.
- The top row has two separate bordered timing widgets:
  - `Study view timings` for view/path average durations.
  - `Study detector timings` for detector and candidate average durations.
- `tab` switches focus between the timing widgets; the focused widget has a white border.
- Plain `↑/↓` scrolls the focused widget by a page.
- `option/alt + ↑/↓` and `j/k` scroll the focused widget by one row.
- Study timing samples may carry a group field (`view` or `detector`) so charts do not share scroll state or row sets.
- The study footer is intentionally compact: current asset/work messages belong in the study panels, while the footer is reserved for global status and key hints.
- The renderer refreshes continuously and requests immediate renders after key input, so active study runs should not look idle just because one CPU-bound asset is still inside scanner work.

### Slice 5 — first real plugin
- Rebuild the view study as `view-proposals` with `view-order` as a compatibility alias.
- Produce `tools/bench/reports/study-view-proposals.json` plus timestamped snapshots.
- Keep production source of truth in `packages/ironqr/src/pipeline/views.ts`.

## Open questions
1. Should study reports live under `apps/docs` as checked-in evidence, or only under `tools/bench/reports`?
2. Do we need a generic table/CSV export now, or is JSON enough?
3. Should plugin flags support arrays in slice 1, or defer until the first plugin needs them?
4. Should study plugins be allowed to call third-party engines, or should studies initially focus on first-party `ironqr` internals?
5. How much git metadata should be captured when the repo is dirty?

## Recommendation
Build the smallest static plugin system now:
- typed plugin interface
- static registry
- shared corpus loader
- common report envelope
- optional plugin-owned cache

When a study needs deeper scanner evidence, add that evidence to `ironqr` as an explicit opt-in diagnostics or metrics option rather than keeping it trapped in bench-only code. The option must default off and preserve production performance.

Defer dynamic loading, declarative workflows, and generalized plugin dependency management until several real studies prove the shape.
