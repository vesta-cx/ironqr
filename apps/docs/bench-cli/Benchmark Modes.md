# Benchmark Modes

Related: [[Bench Study Plugin Contract]], [[View Study]], [[Diagnostics and Benchmark Boundary]]

## Purpose
Define clear responsibilities for `tools/bench` commands so the full suite, accuracy, performance, and studies do not grow overlapping flags.

## Decision
Split benchmark concerns by command:

- `bench` with no subcommand: full suite for regression tracking across accuracy and performance
- `bench accuracy`: focused correctness comparison and coarse timing
- `bench performance`: focused first-party `ironqr` profiling with detailed timing and memory metrics
- `bench study <id>`: focused corpus-scale experiments that may consume accuracy/performance reports or first-party diagnostics

Remove `--ironqr-trace full` from `bench accuracy`. Full trace capture belongs in the full-suite runner, `bench performance`, or dedicated study commands — not in the focused pass/fail accuracy runner.

## `bench` full suite

### Job
Answer: **Did the scanner regress on either correctness or cost?**

Running `bun run bench` should execute the standard regression suite:

1. accuracy benchmark
2. performance benchmark with full first-party timing trace / metrics
3. combined summary suitable for CI, local pre-PR checks, and release gates

The full suite is the best quick signal for both vectors:
- correctness: did we decode the right things?
- performance: did we spend more time or memory to get there?

### Scope
The full suite should collect enough detail to diagnose regressions without rerunning immediately:
- all accuracy metrics from `bench accuracy`
- all standard performance metrics from `bench performance`
- full first-party timing metrics for `ironqr`
- report paths for both component reports
- a small combined summary report

### Suggested flags

```sh
bun run bench
bun run bench --refresh-cache
bun run bench --no-cache
bun run bench --no-progress
bun run bench --workers 8
bun run bench --max-assets 25
```

Full-suite flags should be the shared subset that makes sense for both accuracy and performance. More specialized flags belong on subcommands.

### Exit behavior
The full suite should fail when:
- accuracy gates fail
- performance gates fail, once thresholds exist
- either component runner errors

Until performance thresholds are established, performance should report regressions but not necessarily fail CI by default.

## `bench accuracy`

### Job
Answer: **How does `ironqr` compare to other engines?**

We are writing our own engine and want it to be competitive. Third-party engines are baselines, not the product under test.

### Scope
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

### Out of scope
Accuracy mode should not produce full pipeline analytics.

Avoid:
- full trace event arrays
- per-stage timing reports
- memory profiling
- view-level proposal cost analysis
- decode-attempt breakdowns beyond coarse first-party summaries needed to classify failure

### Trace policy
Accuracy may keep a cheap first-party summary if it helps classify broad failure buckets or debug obvious regressions, but it should not expose `--ironqr-trace full`.

Recommended flags:

```sh
bun run bench accuracy
bun run bench accuracy --refresh-cache
bun run bench accuracy --no-cache
bun run bench accuracy --no-progress
bun run bench accuracy --workers 8
bun run bench accuracy --verbose
```

Do not add `--engine`. Benchmarks should always run every available engine so comparisons stay stable and omissions do not hide regressions.

## `bench performance`

### Job
Answer: **How fast and memory-efficient is `ironqr` compared to other engines, and where does `ironqr` spend its own budget?**

We do care about baseline engines here because `ironqr` should be competitive or better. Baselines provide comparative throughput and latency targets. `ironqr` additionally gets deep internal profiling because it is the engine we can improve.

### Scope
Performance mode should produce two layers:

1. comparative performance across `ironqr` and every available baseline engine
2. first-party `ironqr` internals for detailed optimization work

Comparative metrics should include:
- total scan duration distributions by engine
- p50/p95/p99 by engine
- slowest assets by engine
- simple correctness buckets so timings are interpretable:
  - `pos-pass`
  - `pos-fail`
  - `neg-pass`
  - `neg-fail`

`ironqr` internal metrics should include:
- per-stage duration distributions
- per-view proposal-generation timing
- scalar/binary view materialization timing
- ranking/clustering/structure/geometry/decode-cascade timing
- decode-attempt timing grouped by decode view, sampler, and refinement
- memory deltas or samples when practical

The performance report does not need detailed failure reasons. It only needs to know whether the asset outcome was expected or unexpected, plus enough `ironqr` timing detail to optimize the hot path.

### Suggested flags

```sh
bun run bench performance
bun run bench performance --asset asset-123
bun run bench performance --label qr-pos
bun run bench performance --max-assets 25
bun run bench performance --refresh-cache
bun run bench performance --no-cache
bun run bench performance --no-progress
bun run bench performance --workers 4
bun run bench performance --report-file tools/bench/reports/performance.json
```

Do not add `--engine`. Performance benchmarks should always run every available engine. Only `ironqr` gets deep internal stage/view/decode profiling; baseline engines get black-box duration and outcome buckets.

Do not add `--profile-memory`. When memory profiling exists, it should be on by default for `bench performance` and the full suite.

## Performance observability contract

Performance mode needs richer `ironqr` metrics than accuracy mode and richer metrics than baseline engines can expose. Add them behind explicit opt-in options so production scans remain cheap.

Good `ironqr` observability surfaces:
- timing spans around named stages
- per-view timing summaries
- per-decode-attempt timing summaries
- memory samples at stage boundaries when enabled
- structured metrics sinks that do not allocate full event arrays unless requested

Bad surfaces:
- benchmark-only branches that change scanner behavior
- string logs
- always-on timers in production paths
- command-specific flags inside `ironqr`

A target shape could be:

```ts
scanFrame(input, {
  diagnostics: {
    timings: 'summary',
    memory: 'off',
  },
});
```

or a lower-level sink:

```ts
scanFrame(input, {
  metricsSink,
});
```

The exact `ironqr` API can evolve, but the rule is stable: performance metrics are opt-in and general-purpose enough for consumers tuning scanner policy.

## `bench study <id>`

### Job
Answer: **What policy should we choose?**

Studies may consume:
- corpus assets
- accuracy reports
- performance reports
- opt-in `ironqr` diagnostics or metrics

A study should not duplicate the whole accuracy or performance runner unless its experiment requires it.

Examples:
- `view-order`: use proposal/view metrics to recommend proposal-view ordering
- `decode-budget`: use performance metrics and pass/fail buckets to tune decode budgets
- `early-exit`: use structure metrics to tune cheap rejection thresholds

## Report relationship

Accuracy report answers how `ironqr` compares to baseline engines on correctness.
Performance report answers how `ironqr` compares to baseline engines on cost and where `ironqr` spends its own time/memory.
Study reports answer policy.
Full-suite report answers whether the branch regressed across the standard gates.

They should share a report envelope where practical, but they should not all expose the same flags or collect the same data.

Recommended default outputs:

```txt
tools/bench/reports/accuracy.json
tools/bench/reports/performance.json
tools/bench/reports/summary.json
```

## Migration plan

1. Make `bun run bench` the full-suite entrypoint instead of the current accuracy-home behavior.
2. Remove `--ironqr-trace full` from focused accuracy mode.
3. Keep or replace cheap accuracy summaries needed for broad failure classification.
4. Implement `bench performance` as an `ironqr`-only profiler.
5. Add opt-in timing metrics to `ironqr` behind a diagnostics/metrics option.
6. Have the full suite run accuracy plus performance and write a combined summary report.
7. Add memory profiling to performance/full-suite runs once timing profiles are stable.
8. Let studies consume performance reports instead of rerunning full traces by default.
