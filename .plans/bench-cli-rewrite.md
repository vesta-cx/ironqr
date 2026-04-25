# Bench CLI Rewrite Plan

Work in .worktrees/study-plugin-contract

## Goal

Rewrite `tools/bench` from the ground up as an OpenTUI-first benchmark suite for tracking `ironqr` against baseline engines on both correctness and cost.

The current `tools/bench` CLI is reference material, not the target shape. Reuse its lessons and useful internals, but redesign the command model, reports, progress UI, and profiling boundary around the benchmark modes below.

## Command model

```sh
bun run bench                    # full suite: accuracy + performance + summary
bun run bench accuracy           # compare ironqr correctness vs all baseline engines
bun run bench performance        # compare speed vs all baseline engines + deep ironqr profile
bun run bench study <study-id>   # focused policy experiments, e.g. view-order
bun run bench engines            # list available engines and capabilities
```

No-subcommand `bun run bench` is not a home screen. It runs the standard full-suite regression benchmark.

## Non-negotiables

- OpenTUI is the only progress UI.
- `--no-progress` disables OpenTUI for log-only runs.
- No `--progress=plain|dashboard|tui|auto` modes.
- No `--engine` flag in benchmarks. Full-suite, accuracy, and performance always run the full target engine set so comparisons stay stable and omissions do not hide regressions.
- Memory profiling is not part of this rewrite. Track it as a follow-up issue after timing profiling lands.
- Focused `bench accuracy` does not support full trace collection.
- Full trace / deep timing belongs in `bench`, `bench performance`, or studies.
- Study plugin IDs are simple strings, not namespaced IDs. We are designing studies for `ironqr` only.

## Modes

### `bench` full suite

#### Question

Did this branch regress on either correctness or speed?

#### Behavior

Runs:

1. `accuracy`
2. `performance`
3. combined summary/gate report

#### Outputs

```txt
tools/bench/reports/accuracy.json
tools/bench/reports/performance.json
tools/bench/reports/summary.json
tools/bench/reports/runs/<timestamp>-<short-sha>/accuracy.json
tools/bench/reports/runs/<timestamp>-<short-sha>/performance.json
tools/bench/reports/runs/<timestamp>-<short-sha>/summary.json
```

Write stable latest files for humans/tools and timestamped run snapshots for history. Regression checks compare the current `summary` object against the previous latest `summary.json` before overwriting it when that file exists. If there is no previous summary, mark regression status as `unavailable`.

#### Suggested flags

```sh
bun run bench
bun run bench --refresh-cache
bun run bench --no-cache
bun run bench --no-progress
bun run bench --workers 8
bun run bench --max-assets 25
```

Only shared options belong here. Specialized knobs belong on focused subcommands.

#### Exit behavior

Fail when:

- a repeated worker crash prevents completing the benchmark
- an unrecoverable runner error occurs

Accuracy/performance pass/fail and regression checks are semantic report fields only. This CLI is not intended for CI gating, and those benchmark verdicts should not drive the process exit code.

### `bench accuracy`

#### Question

How does `ironqr` compare to other engines?

We are writing our own engine and want it to be competitive. Third-party engines are baselines, not the product under test.

#### Scope

Accuracy mode should produce:

- `ironqr` positive pass/fail/partial-pass counts
- `ironqr` negative pass/false-positive/error counts
- baseline engine positive/negative results for comparison
- gaps where `ironqr` fails and another engine succeeds
- wins where `ironqr` succeeds and another engine fails
- per-engine pass rates
- coarse per-asset wall-clock duration
- slowest assets by wall-clock duration
- cache hit/miss/write counts

#### Out of scope

Accuracy mode should not produce full pipeline analytics.

Avoid:

- full trace event arrays
- per-stage timing reports
- memory profiling
- view-level proposal cost analysis
- decode-attempt timing breakdowns

Accuracy may keep cheap first-party summary diagnostics if they help broad failure classification, but the rewritten accuracy command should not include a full-trace flag.

#### Suggested flags

```sh
bun run bench accuracy
bun run bench accuracy --refresh-cache
bun run bench accuracy --no-cache
bun run bench accuracy --no-progress
bun run bench accuracy --workers 8
```

No `--engine`: always run the full wired target engine set.

### `bench performance`

#### Question

How fast is `ironqr` compared to other engines, and where does `ironqr` spend its own budget?

Baseline engines matter because `ironqr` should be competitive or better. Baselines provide comparative throughput and latency targets. `ironqr` additionally gets deep internal profiling because it is the engine we can improve.

#### Scope

Performance mode has two layers:

1. comparative performance across `ironqr` and every wired target baseline engine
2. first-party `ironqr` internals for detailed optimization work

Comparative metrics:

- total scan duration distributions by engine
- p50/p95/p99 by engine
- slowest assets by engine
- throughput by engine
- simple correctness buckets so timings are interpretable:
  - `pos-pass`
  - `pos-fail`
  - `neg-pass`
  - `neg-fail`

`ironqr` internal metrics:

- per-stage duration distributions
- per-view proposal-generation timing
- scalar/binary view materialization timing
- ranking/clustering/structure/geometry/decode-cascade timing
- decode-attempt timing grouped by decode view, sampler, and refinement

The performance report does not need detailed failure reasons. It only needs to know whether the asset outcome was expected or unexpected, plus enough `ironqr` timing detail to optimize the hot path.

#### Suggested flags

```sh
bun run bench performance
bun run bench performance --asset asset-123
bun run bench performance --label qr-pos
bun run bench performance --max-assets 25
bun run bench performance --refresh-cache
bun run bench performance --no-cache
bun run bench performance --no-progress
bun run bench performance --workers 4
bun run bench performance --iterations 8
bun run bench performance --report-file tools/bench/reports/performance.json
```

No `--engine`: always run the full wired target engine set.

Memory profiling is out of scope for this rewrite. Follow-up design issue: #47.

### `bench study <study-id>`

#### Question

What scanner policy should we choose?

Studies may consume:

- corpus assets
- accuracy reports
- performance reports
- opt-in `ironqr` diagnostics or metrics

Studies should not duplicate the whole accuracy or performance runner unless the experiment requires it.

Example studies:

- `view-order`: recommend proposal-view ordering from proposal/view metrics
- `decode-budget`: tune decode budgets from performance metrics and pass/fail buckets
- `early-exit`: tune cheap rejection thresholds from structure metrics

Study IDs are simple strings:

```sh
bun run bench study view-order
bun run bench study decode-budget
```

## Target engine set

Benchmarks always target `ironqr` plus the full baseline engine set. There is no `--engine` selection flag.

Target third-party engines:

| Engine id | Package / integration | Notes |
| --- | --- | --- |
| `zxing-cpp` | `zxing-wasm` | Strong native/WASM baseline; important competitiveness target. |
| `zbar` | `@undecaf/zbar-wasm` | Mature barcode scanner baseline. |
| `jsqr` | `jsqr` | Common pure-JS QR baseline. |
| `zxing` | `@zxing/library` | JS ZXing implementation; useful ecosystem baseline. |
| `quirc` | `quirc` | QR-focused C-library lineage via package integration. |
| `opencv` | OpenCV QR detector integration | Computer-vision baseline; exact package/integration TBD. |

Availability rules:
- "Available" means the adapter is implemented and wired into this bench CLI.
- `ironqr` must be available or the benchmark fails.
- Every wired target baseline engine must run. If any wired baseline engine fails to load, warm up, or scan, the benchmark hard-fails.
- Reports should list the full target engine set and the exact failure reason for any engine failure.

## Shared global flags

Shared where meaningful:

```sh
--asset <id>              # repeatable corpus asset filter
--label <qr-pos|qr-neg>
--max-assets <n>           # sample n assets after filters
--seed <value>             # deterministic sampling seed; random when omitted
--workers <n>
--iterations <n>           # performance only; default 8
--refresh-cache [engine-id]
--no-cache
--cache-file <path>
--report-dir <path>
--report-file <path>      # focused command single report
--no-progress             # disables OpenTUI
--help
```

Do not make every flag valid everywhere. Unsupported shared flags should fail clearly rather than being silently ignored.

`--refresh-cache` without a value refreshes all cache domains touched by the command. `--refresh-cache <engine-id>` refreshes only cached entries for that engine, e.g. `--refresh-cache ironqr`. This is useful when iterating on `ironqr` without invalidating stable third-party engine measurements.

## Project structure

Target from-scratch structure:

```txt
tools/bench/src/
  cli/
    args.ts                  # parse global + command args
    commands.ts              # command dispatch
    usage.ts                 # command-specific usage
  core/
    corpus.ts                # approved corpus loading, filters, lazy image loading
    engines.ts               # engine registry + availability
    cache.ts                 # shared json cache primitives
    reports.ts               # common report envelope, paths, git metadata
    runner.ts                # shared worker/concurrency helpers
    outcome.ts               # pos-pass/pos-fail/neg-pass/neg-fail helpers
  ui/
    app.ts                   # OpenTUI app shell
    model.ts                 # command-neutral run model
    panels/
      header.ts
      progress.ts
      scorecard.ts
      comparison.ts
      timing.ts
      slowest.ts
      logs.ts
  accuracy/
    command.ts
    runner.ts
    scoring.ts
    report.ts
  performance/
    command.ts
    runner.ts
    ironqr-profiler.ts
    report.ts
  issues/
    memory-profiling.md      # follow-up issue draft, not part of rewrite implementation
  studies/
    command.ts
    registry.ts
    contract.ts
    view-order.ts
  suite/
    command.ts               # no-subcommand full-suite runner
    report.ts
  engines/
    adapters/
      ironqr.ts
      jsqr.ts
      zxing.ts
      zxing-cpp.ts
      zbar.ts
      quirc.ts
```

## Timing rules

Performance timing must separate phases so optimization work can target the right layer:

- `imageLoadDurationMs`: read/decode/normalize source image data for the asset
- `warmupDurationMs`: unmeasured warmup scan for each engine
- `engineScanDurationMs`: measured engine scan call duration
- `totalJobDurationMs`: end-to-end worker job duration

Do not omit image-load time. It should not be the primary engine comparison metric, but it is still reported because image loading and normalization may become optimization targets.

Every engine gets a warmup run before measured iterations. The warmup asset is sampled randomly from the selected corpus for that benchmark run and recorded in the report. Warmup timing is reported separately and excluded from measured p50/p95/p99 scan timings.

`bench performance` runs `--iterations <n>` measured iterations per selected asset, defaulting to `8`. Cache all measured iteration durations, not just aggregates, so reports can compute new summaries later without rerunning. `--refresh-cache` controls which cached engine measurements are discarded before running.

## Corpus selection and sampling

Corpus filtering order:

1. load approved corpus assets
2. apply explicit filters (`--asset`, `--label`, future strata filters)
3. shuffle with a seed
4. apply `--max-assets <n>`

`--max-assets` should sample `n` assets instead of taking the first `n`. This avoids repeatedly benchmarking the same prefix of the manifest during local smoke runs.

If `--seed` is provided, sampling is deterministic and the seed must be recorded in the report envelope. If `--seed` is omitted, accuracy/performance/full-suite runs generate a random seed, print it in OpenTUI/log output, and record it in the report so a surprising run can be reproduced.

Studies are different: `bench study <id> --max-assets <n>` should be deterministic by default. A tuning study may run many parameter variations in one invocation, and every variation must evaluate the same sampled asset set. If no `--seed` is supplied for a study, derive a stable seed from the study id plus normalized corpus filters and record it in the report. Users can still pass `--seed` to override the deterministic default.

Explicit `--asset` filters should preserve the user's chosen set; if `--max-assets` is also supplied, sample from that explicit set and warn/report that both filters were applied.

## Shared corpus contract

Extract current manifest loading into shared core. All modes use this shape:

```ts
interface BenchCorpusAsset {
  readonly id: string;
  readonly label: "qr-pos" | "qr-neg";
  readonly sha256: string;
  readonly relativePath: string;
  readonly imagePath: string;
  readonly expectedTexts: readonly string[];
  readonly loadImage: () => Promise<BenchImageData>;
}
```

No mode should re-read the corpus manifest ad hoc.

## Shared outcome buckets

Use coarse pass/fail buckets for performance and full-suite summaries:

```ts
type BenchOutcomeBucket =
  | "pos-pass"
  | "pos-partial"
  | "pos-fail"
  | "neg-pass"
  | "neg-fail";
```

Accuracy needs richer outcome kinds because correctness work depends on knowing how a result failed:

```ts
type AccuracyPositiveOutcome =
  | "pass"
  | "partial-pass"
  | "fail-no-decode"
  | "fail-mismatch"
  | "fail-error";

type AccuracyNegativeOutcome =
  | "pass"
  | "false-positive"
  | "fail-error";
```

Accuracy reports should preserve decoded text, expected text, matched text, and error text where available. Performance can collapse these richer outcomes into `BenchOutcomeBucket` because it only needs pass/fail context to interpret timings.

## Shared report envelope

Every report should share an envelope with human-readable context and a top-level summary. Reports are artifacts for future readers, not just machine blobs.

```ts
interface BenchReportEnvelope<Kind extends string, Summary extends object, Details> {
  readonly kind: Kind;
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly benchmark: {
    readonly name: string;
    readonly description: string;
  };
  readonly status: "passed" | "failed" | "errored" | "interrupted";
  readonly verdicts: {
    readonly pass: BenchmarkVerdict;
    readonly regression: BenchmarkVerdict;
  };
  readonly command: {
    readonly name: "suite" | "accuracy" | "performance" | "study";
    readonly argv: readonly string[];
  };
  readonly repo: {
    readonly root: string;
    readonly commit: string | null;
    readonly dirty: boolean | null;
  };
  readonly corpus: {
    readonly manifestPath: string;
    readonly assetCount: number;
    readonly positiveCount: number;
    readonly negativeCount: number;
    readonly manifestHash: string;
    readonly assetIds: readonly string[];
  };
  readonly selection: {
    readonly seed: string | null;
    readonly filters: Record<string, unknown>;
  };
  readonly engines: readonly EngineRunDescriptor[];
  readonly options: Record<string, unknown>;
  readonly summary: Summary;
  readonly details: Details;
}

interface BenchmarkVerdict {
  readonly status: "passed" | "failed" | "unavailable";
  readonly description: string;
}

interface EngineRunDescriptor {
  readonly id: string;
  readonly adapterVersion: string;
  readonly packageName?: string;
  readonly packageVersion?: string;
  readonly runtimeVersion?: string;
}
```

`status` describes whether the report is complete. `interrupted` reports are valid partial artifacts and must not be confused with full benchmark results.

Define these schemas in TypeScript so implementations are consistent across modes. Runtime schema validation is not required because benchmark reports are generated artifacts, not trusted input.

`benchmark.description` should include the benchmark's purpose, the question it answers, and what a reader should inspect first. Example: an accuracy report description should explain that it compares `ironqr` to baseline engines and tell readers to start with `summary.ironqr`, `summary.gaps`, then detailed asset rows for misses.

`summary` is different for each benchmark mode, but it always hosts the reader-first digest of the full report below it: sums, averages, pass rates, p95/p99, wins/losses against other engines, gates, and the most important assets to inspect. The detailed rows live under `details`.

## Verdicts and regression checks

Benchmark verdicts are semantic report fields, not CI gates.

Accuracy pass verdict:
- `ironqr` has zero false positives.
- Every asset passed by any third-party engine is also passed by `ironqr`.
- Partial positive passes do not satisfy a full third-party pass unless the compared baseline also only partially passed the same asset.

Accuracy regression verdict:
- Compare only the current `summary` object against the previous latest `summary.json` when available.
- Mark as failed if `ironqr` pass/false-positive/gap summary metrics are worse than the previous summary.
- Mark as `unavailable` when no previous summary exists or schemas are incompatible.

Performance pass verdict:
- `ironqr` is competitive or better than every third-party engine across top-level summary metrics.
- Initial metrics: p50, p95, p99, average duration, and throughput.
- Exact tolerance can start at zero or a small documented threshold once real measurements show noise.

Performance regression verdict:
- Compare only the current `summary` object against the previous latest `summary.json` when available.
- Mark as failed if top-level `ironqr` timing/ranking metrics are worse beyond the configured tolerance.
- Mark as `unavailable` when no previous summary exists or schemas are incompatible.

## Report benchmark descriptions

Each report must populate `benchmark.name` and `benchmark.description` with stable, reader-oriented prose.

### Suite report

`benchmark.name`: `Bench Full Suite`

`benchmark.description`:

> Runs the standard `ironqr` benchmark suite: accuracy comparison against every target baseline engine plus performance comparison/profiling. This report answers whether the current branch regressed on correctness or speed. Start with `summary.verdicts`, then inspect `summary.highlights`, then open the linked accuracy and performance reports for details.

### Accuracy report

`benchmark.name`: `Accuracy Benchmark`

`benchmark.description`:

> Compares `ironqr` correctness against every target baseline engine on the selected corpus. This report answers where `ironqr` is ahead of, tied with, or behind other engines. Start with `summary.ironqr`, then inspect `summary.gaps` for baseline passes that `ironqr` missed and `ironqr` wins that baselines missed. Use `details.assets` for per-asset decoded text, expected text, matched text, and error details.

### Performance report

`benchmark.name`: `Performance Benchmark`

`benchmark.description`:

> Compares `ironqr` scan speed against every target baseline engine and records detailed first-party timing metrics for `ironqr`. This report answers whether `ironqr` is competitive on latency/throughput and where it spends time internally. Start with `summary.ranking`, `summary.ironqr`, and `summary.hotSpots`, then inspect `details.assets` for per-asset iteration timings and `details.ironqrProfile` for stage/view/decode-attempt breakdowns.

### Study report

`benchmark.name`: `Study: <study id>`

`benchmark.description`:

> Records evidence for a focused scanner-policy study. This report answers the study-specific policy question described by the plugin. Start with the study-defined `summary`, then inspect `details` for the evidence rows, sampled assets, and parameter variations that produced the recommendation.

## Accuracy report shape

```ts
interface AccuracyReportSummary {
  readonly ironqr: AccuracyEngineSummary;
  readonly baselines: readonly AccuracyEngineSummary[];
  readonly gaps: {
    readonly ironqrMissedBaselineHitCount: number;
    readonly ironqrHitBaselineMissedCount: number;
    readonly topIronqrMissedBaselineHits: readonly EngineGap[];
    readonly topIronqrHitBaselineMisses: readonly EngineGap[];
  };
  readonly pass: BenchmarkVerdict;
  readonly regression: BenchmarkVerdict;
  readonly cache: CacheSummary;
}

interface AccuracyReportDetails {
  readonly engines: readonly EngineDescriptor[];
  readonly assets: readonly AccuracyAssetComparison[];
  readonly gaps: {
    readonly ironqrMissedBaselineHit: readonly EngineGap[];
    readonly ironqrHitBaselineMissed: readonly EngineGap[];
  };
}

type AccuracyReport = BenchReportEnvelope<
  "accuracy-report",
  AccuracyReportSummary,
  AccuracyReportDetails
>;
```

## Performance report shape

```ts
interface PerformanceReportSummary {
  readonly ironqr: PerformanceEngineSummary;
  readonly baselines: readonly PerformanceEngineSummary[];
  readonly ranking: {
    readonly ironqrP95Rank: number | null;
    readonly ironqrThroughputRank: number | null;
  };
  readonly hotSpots: {
    readonly slowestStages: readonly TimingSummary[];
    readonly slowestProposalViews: readonly ViewTimingSummary[];
    readonly slowestDecodeAttempts: readonly DecodeAttemptTimingSummary[];
  };
  readonly pass: BenchmarkVerdict;
  readonly regression: BenchmarkVerdict;
  readonly cache: CacheSummary;
}

interface PerformanceReportDetails {
  readonly engines: readonly PerformanceEngineSummary[];
  readonly assets: readonly PerformanceAssetResult[];
  readonly ironqrProfile: IronqrPerformanceProfile | null;
}

type PerformanceReport = BenchReportEnvelope<
  "performance-report",
  PerformanceReportSummary,
  PerformanceReportDetails
>;

interface PerformanceEngineSummary {
  readonly engineId: string;
  readonly assetCount: number;
  readonly p50DurationMs: number;
  readonly p95DurationMs: number;
  readonly p99DurationMs: number;
  readonly averageDurationMs: number;
  readonly throughputAssetsPerSecond: number;
  readonly buckets: Record<BenchOutcomeBucket, number>;
}

interface IronqrPerformanceProfile {
  readonly stages: readonly TimingSummary[];
  readonly proposalViews: readonly ViewTimingSummary[];
  readonly decodeViews: readonly ViewTimingSummary[];
  readonly samplers: readonly TimingSummary[];
  readonly refinements: readonly TimingSummary[];
  readonly decodeAttempts: readonly DecodeAttemptTimingSummary[];
}
```

## Full-suite report shape

```ts
interface SuiteReportSummary {
  readonly verdicts: {
    readonly accuracyPass: BenchmarkVerdict;
    readonly accuracyRegression: BenchmarkVerdict;
    readonly performancePass: BenchmarkVerdict;
    readonly performanceRegression: BenchmarkVerdict;
  };
  readonly highlights: {
    readonly ironqrAccuracyRank: number | null;
    readonly ironqrSpeedRank: number | null;
    readonly ironqrPassRate: number;
    readonly ironqrP95DurationMs: number;
    readonly biggestAccuracyGaps: readonly AccuracyGap[];
    readonly slowestIronqrAssets: readonly SlowAsset[];
  };
}

interface SuiteReportDetails {
  readonly accuracyReportFile: string;
  readonly performanceReportFile: string;
}

type SuiteReport = BenchReportEnvelope<"suite-report", SuiteReportSummary, SuiteReportDetails>;
```

## `ironqr` metrics API needed

Do not use full trace arrays as the performance primitive. Add opt-in metrics designed for aggregation.

Target shape:

```ts
scanFrame(input, {
  diagnostics: {
    timings: "summary",
  },
  metricsSink,
});
```

or:

```ts
interface ScanMetricsSink {
  span(event: ScanTimingSpan): void;
}
```

Timing span:

```ts
interface ScanTimingSpan {
  readonly type: "timing-span";
  readonly name:
    | "normalize"
    | "scalar-view"
    | "binary-view"
    | "proposal-view"
    | "ranking"
    | "clustering"
    | "structure"
    | "geometry"
    | "decode-attempt"
    | "decode-cascade";
  readonly durationMs: number;
  readonly assetId?: string;
  readonly binaryViewId?: string;
  readonly scalarViewId?: string;
  readonly proposalId?: string;
  readonly decodeBinaryViewId?: string;
  readonly sampler?: string;
  readonly refinement?: string;
  readonly outcome?: string;
}
```

Performance/full-suite benchmarks request these timing metrics. Production scans do not pay for them by default.

Memory profiling is intentionally out of scope for this rewrite. Create a follow-up GitHub issue after timing profiling lands.

## OpenTUI design

One command-neutral shell.

Panels:

- header: command, corpus count, engine count, phase
- progress: jobs complete, workers active
- scorecard:
  - accuracy: pass rates and gaps
  - performance: p95/p99 and throughput
  - suite: verdicts
- comparison table:
  - engines as rows
  - pass rate / false positives / p95 / p99
- active jobs
- slowest assets
- recent completions
- footer: report paths, keybindings

Keybindings:

```txt
q request graceful stop
p pause or freeze rendering for copy
↑/↓ scroll focused panel
tab switch panel focus
? help
```

`--no-progress` disables OpenTUI and writes reports with minimal stdout.

## Failure handling

Prefer graceful exit whenever possible.

- If a worker crashes, restart it and retry the asset that was in flight.
- If the same asset/engine repeatedly crashes, stop scheduling new work, write a partial report with `status: "errored"`, and exit non-zero with a clear trace of what happened.
- If the user requests stop, finish in-flight work where practical, write a partial report with `status: "interrupted"`, and exit cleanly.
- Partial reports must include completed assets, skipped/pending counts, and failure/interruption reason.

## Cache model

Shared cache infra, separate cache domains:

```ts
type CacheDomain = "accuracy" | "performance" | `study:${string}`;
```

Cache key includes:

- engine id
- engine version/cache version
- asset id
- asset sha256
- command options relevant to result
- `ironqr` metrics mode if performance

Accuracy cache can store scan results.

Performance cache may store measured timings, but it must store every iteration measurement, not just aggregates. Cached performance entries must include engine id/version, asset sha, iteration count, timing metric version, and relevant options so stale measurements are invalidated predictably.

`--refresh-cache` means rerun/recompute and write fresh cache state. `--refresh-cache <engine-id>` refreshes only that engine's cache entries.

## Study plugin contract

```ts
interface StudyPlugin {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly version: string;
  readonly flags?: readonly StudyPluginFlag[];
  run(context: StudyContext): Promise<StudyResult>;
}
```

Studies can consume:

- corpus assets
- accuracy report
- performance report
- opt-in `ironqr` metrics
- plugin cache

Study sampling must be stable within and across repeated runs with the same study id, filters, corpus, and seed. This keeps tuning loops honest: each candidate parameter set should be judged on the same asset sample.

First study target: `view-order`.

## Migration from current CLI

Reuse:

- engine adapters
- accuracy scoring concepts
- report summarization concepts
- worker-pool lessons
- OpenTUI dashboard components
- cache-store lessons

Replace:

- CLI parser shape
- progress modes
- placeholder performance command
- focused accuracy-mode full trace collection
- default no-subcommand home behavior
- namespaced study IDs
- optional engine selection
- optional memory profiling flag

## Implementation slices

### Slice 1 — CLI skeleton

- New `cli/args.ts` and command dispatch.
- Commands: `suite`, `accuracy`, `performance`, `study`, `engines`.
- No-subcommand dispatches to suite.
- OpenTUI only, with `--no-progress`.
- Omit `--engine` and `--progress` modes from the new CLI.

### Slice 2 — shared core

- Extract corpus loading.
- Extract engine registry.
- Extract report envelope.
- Shared filters/options.
- Seeded random sampling for `--max-assets`.

### Slice 3 — accuracy rewrite

- Port existing accuracy runner onto new core.
- Always run the full wired target engine set.
- Emphasize `ironqr` gaps/wins vs baselines.
- Do not include focused accuracy-mode full trace collection.
- Keep coarse timings.

### Slice 4 — performance MVP

- Black-box duration comparison across the full wired target engine set.
- Outcome buckets only.
- p50/p95/p99 and throughput.
- No deep internals yet.

### Slice 5 — `ironqr` metrics

- Add opt-in timing spans to `ironqr`.
- Wire `bench performance` to collect metrics for `ironqr`.
- Add per-stage/per-view/per-decode summaries.

### Slice 5.5 — memory profiling follow-up issue

- Track memory profiling in #47.
- Do not implement memory profiling in this rewrite.

### Slice 6 — full suite

- Run accuracy plus performance.
- Write `summary.json`.
- Add pass/regression verdicts.

### Slice 7 — studies

- Static registry.
- `view-order` first.
- Consume performance metrics where possible.

## Final UX

```sh
bun run bench
# tell me if this branch regressed

bun run bench accuracy
# show me where ironqr is behind/ahead of baselines on correctness

bun run bench performance
# show me whether ironqr is fast enough and where it spends time

bun run bench study view-order
# help me choose scanner policy
```

Accuracy compares correctness. Performance compares cost and profiles `ironqr`. Full suite guards both. Studies turn evidence into policy.
