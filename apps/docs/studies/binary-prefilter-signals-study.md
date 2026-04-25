# Detector Variant Study: Flood + Matcher

## Abstract

This detector-only study evaluates IronQR finder-evidence implementations by comparing sorted `FinderEvidence[]` signatures and timing over the approved corpus. It does **not** measure proposal ranking, clustering, structure fitting, module sampling, decode success, or false positives.

The current evidence supports two detector leads:

1. **Matcher lead: `run-map`.** A full-corpus legacy-vs-run-map matcher comparison found `0` mismatched asset/view rows and an `88.93%` matcher-time reduction.
2. **Flood lead: `scanline-squared`.** The corrected clean confirmation measured only `dense-stats`, `scanline-stats`, and `scanline-squared`; both scanline variants preserved `dense-stats` output over all `10,962` asset/view comparisons, and `scanline-squared` won the head-to-head on avg, p95, p98, p99, max, and queued p98.
3. **Row-scan lead: `row-scan`.** The stable row-scan detector now uses scalar ratio scoring. The row-only optimization run found `row-scan-scalar-score` equivalent over all `10,962` comparisons and `4.34%` faster overall than the cached legacy row-scan control.

The study has moved through successive controls: legacy matcher → run-map matcher, legacy flood → inline stats flood, inline flood → dense stats, and now dense stats → scanline-squared. Retired controls and eliminated candidates remain in the evidence ledger but should not be active default variants.

## Thesis

A detector candidate can replace the current production lead only if it preserves the sorted `FinderEvidence[]` signature over the full corpus and materially reduces detector latency, especially p98 tail latency.

For the current flood phase, the thesis is:

> Scanline component labeling plus squared-distance geometry can replace dense per-pixel flood labeling while preserving `dense-stats` finder evidence and reducing flood detector latency under realistic Worker-throughput execution.

Indexed containment lookup is treated as a separate hypothesis:

> Min-x indexed containment lookup may reduce candidate matching cost, but it must be proven equivalent before it can be considered for production.

The latest data rejects the indexed-lookup hypothesis as currently implemented because every indexed hybrid produced `17` mismatched views.

## Decision rule

The unit of evidence is an asset/view detector-output comparison. With `--view-set all` on the full corpus, each detector pattern is compared over:

```text
203 assets × 54 binary views = 10,962 detector-output comparisons
```

A candidate can move toward production only if a full-corpus run reports:

- `outputsEqual === true`
- `mismatchCount === 0`
- runtime improves enough over the current lead to justify implementation and maintenance cost

This study is p98-tail focused by default. Average latency is useful, but a candidate with lower average and worse p98 does not beat a candidate with slightly higher average and better p98 unless there is a deliberate product-policy reason to prefer throughput over tail latency.

Faster candidates with mismatches are design input only. They are not production candidates.

## Scope

In scope:

- detector-output equivalence by sorted `FinderEvidence[]` signature;
- detector timing distributions: `avgMs`, `p85Ms`, `p95Ms`, `p98Ms`, `p99Ms`, `maxMs`;
- Worker-throughput timing effects when scheduler contention is separately measured;
- detector-pattern cache behavior by variant id, view id, and asset hash.

Out of scope:

- decode success and false positives;
- proposal quality and view ranking;
- clustering and structure budgets;
- module sampling and decode-attempt budgets;
- production prefilter gating;
- UI/dashboard behavior except as instrumentation needed to run the study.

## Latency context

The product-level target is a complete 60 FPS frame decision:

```text
1000 ms / 60 fps = 16.67 ms end-to-end per frame
```

Detector-only wins matter when they remove a dominant bottleneck, reduce tail latency, unlock a larger architecture, or preserve accuracy while reducing variance. Detector timings are not end-to-end frame timings, so production changes still require downstream validation.

## Experiment design

For each selected asset/view:

1. materialize the binary view;
2. run canonical detector leads;
3. run active candidate detector variants;
4. sort and compare finder signatures:
   - `source`
   - center x/y
   - horizontal/vertical module sizes
   - score
5. record timing and output counts;
6. cache each detector pattern independently by variant id and view id.

The detector-pattern cache key includes pattern id, view id, asset hash, study version, config, and observability settings. Adding a new detector pattern queues only missing pattern/view rows; cached leads can be reused. `--refresh-cache` is used only when intentionally invalidating prior detector-pattern rows for timing or instrumentation changes.

## Instrumentation refinements

### Generic study execution

Generic study asset execution now supports real Worker-thread execution. Parent process owns reports, progress, and cache writes. Workers execute CPU-heavy detector rows, read existing cache state, and return cache-write intents to the parent so the study cache remains single-writer safe.

Worker semantics:

- omitted `--workers`: default is half available CPUs;
- `--workers N`, `N > 0`: use a real Worker pool;
- `--workers 0`: run generic study assets on the main thread as an instrumentation/Worker-overhead baseline.

### Timing purity

Detector timing excludes:

- Worker startup/import time;
- Worker warmup/JIT startup;
- dashboard render work;
- cooperative yield overhead in Worker and `--workers 0` baseline modes;
- flood scheduler wait after the memory-lane scheduler was added.

Cached preload rows update counts but do not contaminate fresh timing metrics once fresh samples exist.

### Dashboard responsiveness

The dashboard batches high-rate study timing/log messages and renders on a bounded tick. This keeps key handling and graceful interrupt responsive during high-throughput Worker runs.

### Memory-bandwidth contention

Flood labeling is memory-bandwidth sensitive. Running many Workers without coordination inflated per-row detector wall time. The current implementation uses a Worker-shared flood semaphore:

- Worker count remains high for throughput;
- only a bounded number of flood-label sections run at once;
- detector timing starts after acquiring a flood lane;
- scheduler wait is reported separately via `schedulerWaitMs`, `avgSchedulerWaitMs`, `p95SchedulerWaitMs`, `p98SchedulerWaitMs`, and `maxSchedulerWaitMs`;
- queued wall time is reported from per-job samples via `avgQueuedMs`, `p95QueuedMs`, `p98QueuedMs`, and `maxQueuedMs`.

This preserves empirical detector timings: no candidate timing is reconstructed from shared component artifacts or estimates. Queued timing is also computed from each row's own `durationMs + schedulerWaitMs` sample before percentile aggregation; the report does not subtract or add aggregate averages to invent percentiles.

### Scratch-buffer reuse

Each Worker/main-thread isolate reuses scratch typed arrays for dense and scanline component labeling. Each detector variant still performs its own real labeling pass; only backing buffers are reused to reduce allocation and GC churn.

## Experiment design refinement

| Iteration | Design | Why it changed | Evidence produced | Outcome |
| --- | --- | --- | --- | --- |
| 0. Broad detector exploration | Passive signals, materialization timings, detector timings, retired materialization candidates, early matcher/flood variants. | Too many moving parts; useful for hotspot discovery but not production decisions. | Detector work dominated; materialization was not the main issue. | Split into focused detector studies. |
| 1. Matcher exploration | Run-map, center-pruned, seeded, and fused matcher candidates. | Prototype variants mixed correctness and headroom; run-map needed a clean legacy comparison. | Center/seed variants mismatched; run-map looked promising. | Narrowed to legacy matcher vs run-map matcher. |
| 2. Matcher equivalence | Only legacy matcher vs run-map matcher. | Needed direct regression proof for the default matcher. | `0` mismatches over `10,962` comparisons; `88.93%` faster. | Run-map matcher canonized; legacy matcher removed. |
| 3. Flood pass fusion | Legacy two-pass flood vs inline stats vs filtered component matching. | Needed to separate full-pass fusion savings from smaller matching-filter effects. | Inline stats: `0` mismatches, `64.72%` faster. Filtered: `0` mismatches, `1.66%` faster. | Inline flood canonized; legacy/filtered variants retired. |
| 4. Dense flood candidate phase | Inline flood and run-map leads plus dense/spatial/run-length flood candidates. | Test new flood implementations against warmed inline control. | Dense-stats was fastest; all candidates differed on one `gray:h:i` row. Targeted legacy check showed dense/spatial/run-length matched legacy while inline was the odd one out. | Dense-stats canonized as the next flood control. |
| 5. Hybrid flood phase | Dense-stats and run-map leads plus scanline labeling, indexed containment lookup, and squared-distance geometry permutations. | Combine best ideas from prior variants while avoiding fallback/rescue paths. | Repeated full fresh runs found scanline-stats and scanline-squared equivalent; indexed variants mismatched. | `scanline-squared` confirmed as the flood replacement. |
| 6. Throughput instrumentation phase | Real Workers, half-CPU default workers, Worker warmup, sync hot paths, flood memory-lane scheduler, and scheduler-wait reporting. | Multi-worker runs initially measured memory-bandwidth stampede rather than detector cost. | Full `12`-Worker runs with flood limit `6` restored flood avg to `~5–7 ms` and reported wait separately. | Keep scheduler-wait telemetry; tune lane limit separately from algorithm ranking. |
| 7. Matcher reopen phase | Fixed flood at `scanline-squared`; compared `run-pattern`, `axis-intersect`, and `shared-runs` against `run-map`. | Matcher became the dominant detector cost after flood canonization. | All candidates were faster but changed matcher signatures on `8,712–8,760` views. | Keep `run-map`; bin these candidates as replacements. |

## Evidence ledger

### Experiment A — matcher cross-check replacement

**Question.** Can run-map-backed cross-checks replace legacy pixel-walk matcher cross-checks without changing matcher finder evidence?

**Corpus.** `203` assets (`60` positive, `143` negative), all `54` binary view identities, `10,962` asset/view comparisons.

| Metric | Legacy matcher | Run-map matcher | Delta |
| --- | ---: | ---: | ---: |
| Matcher time | 1,847,272.22 ms | 204,453.47 ms | -1,642,818.75 ms |
| Runtime improvement | — | 88.93% | — |
| Output equality | — | `true` | — |
| Mismatched views | — | 0 | — |

**Conclusion.** Run-map matcher is canonical. The legacy matcher path was removed; the low-level `crossCheck` primitive remains only because row-scan uses it.

### Experiment B — flood label/stat pass fusion

**Question.** Can flood-fill combine connected-component labeling and component-stat collection into one pass without changing flood finder evidence?

**Report.** `tools/bench/reports/study/study-binary-prefilter-signals.summary.json`, generated `2026-04-25T04:53:22.049Z` at `eec0662c7af4e4cd284293ce9bcc123ab425e019`, dirty=`false`.

**Corpus.** `203` assets (`60` positive, `143` negative), all `54` binary view identities, `10,962` asset/view comparisons, cache `0` hits / `203` misses / `203` writes.

| Variant | Time | Saved vs legacy | Improvement | Output equal | Mismatched views | Decision |
| --- | ---: | ---: | ---: | --- | ---: | --- |
| Legacy two-pass flood | 443,090.70 ms | — | — | control | 0 | Retired reference. |
| Inline component-stats flood | 156,305.84 ms | 286,784.86 ms | 64.72% | `true` | 0 | Canonical control for next phase. |
| Filtered components over old two-pass path | 435,716.10 ms | 7,374.60 ms | 1.66% | `true` | 0 | Retired; not enough gain. |

**Conclusion.** Inline component-stats flood is canonical for this experiment. It eliminates the old second full-image component-stat traversal and preserves flood finder evidence across the full corpus.

### Experiment C — dense-stats flood control selection

**Question.** Should dense component stats replace inline flood as the flood control?

**Evidence.** The flood-candidate run showed `dense-stats` was `41.38%` faster than `inline-flood`. All active candidates differed from inline flood on one `gray:h:i` row. A targeted legacy check on asset `asset-a3d88885d7915c03`, view `gray:h:i`, showed legacy two-pass flood emitted `3` finders, while inline flood emitted `1`; `dense-stats`, `spatial-bin`, and `run-length-ccl` matched legacy.

**Conclusion.** `dense-stats` became the flood control because it was faster and matched the legacy behavior on the only discovered divergence where inline flood was the odd implementation.

### Experiment D — flood hybrid candidate refresh

**Question.** Which active flood hybrid can replace `dense-stats` while preserving sorted `FinderEvidence[]` signatures over the full corpus?

**Latest report.** `tools/bench/reports/study/study-binary-prefilter-signals.summary.json`, generated `2026-04-25T12:34:23.631Z` from full report `tools/bench/reports/full/study/study-binary-prefilter-signals.json` at `8ba100de9b61e70c462119fd9ffd7f2ed2e20c85`, dirty=`true`.

**Corpus and command.** `203` assets (`60` positive, `143` negative), all `54` binary view identities, `10,962` asset/view comparisons per detector pattern.

```bash
bun run --cwd tools/bench bench study binary-prefilter-signals \
  --view-set all \
  --refresh-cache
```

Cache was refreshed, so timing rows are fresh: `0` hits, `98,658` writes. The run used `12` study workers with flood scheduler limit `6`. Detector timing excludes scheduler wait; scheduler wait and queued wall-time distributions are reported separately.

| Variant | Avg | p95 | p98 | p99 | Queued avg / p98 | Saved vs `dense-stats` | Improvement | Output equal | Mismatched views | Decision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |
| `dense-stats` | 6.60 ms | 13.91 ms | 20.01 ms | 25.56 ms | 7.67 / 21.16 ms | — | — | control | 0 | Current control. |
| `dense-index` | 5.84 ms | 11.08 ms | 13.74 ms | 16.12 ms | 6.97 / 15.49 ms | 8,411.22 ms | 11.62% | `false` | 17 | Exclude; faster but not equivalent. |
| `dense-squared` | 6.24 ms | 13.37 ms | 18.68 ms | 25.01 ms | 7.40 / 20.22 ms | 3,963.82 ms | 5.47% | `true` | 0 | Safe but weaker than scanline candidates. |
| `dense-index-squared` | 5.72 ms | 10.89 ms | 13.06 ms | 14.85 ms | 6.85 / 15.05 ms | 9,734.98 ms | 13.45% | `false` | 17 | Exclude; faster but not equivalent. |
| `scanline-stats` | 5.61 ms | 12.62 ms | 17.85 ms | 24.04 ms | 6.76 / 19.43 ms | 10,957.70 ms | 15.13% | `true` | 0 | Safe, but no longer the best p98 result. |
| `scanline-index` | 4.98 ms | 9.56 ms | 11.90 ms | 13.85 ms | 6.10 / 13.82 ms | 17,807.89 ms | 24.60% | `false` | 17 | Exclude; faster but not equivalent. |
| `scanline-squared` | 5.50 ms | 12.43 ms | 17.61 ms | 22.94 ms | 6.64 / 19.05 ms | 12,091.20 ms | 16.70% | `true` | 0 | Best safe replacement in the latest run. |
| `scanline-index-squared` | 4.94 ms | 9.58 ms | 11.59 ms | 13.21 ms | 6.10 / 13.69 ms | 18,197.44 ms | 25.13% | `false` | 17 | Exclude; fastest but not equivalent. |

**Scheduler result.** Flood scheduling contention is measurable and separately reported:

```text
floodSchedulerLimit: 6
total flood scheduler wait: 99,176.68 ms
average flood scheduler wait: ~1.13 ms/row
p98 flood scheduler wait: ~5.1–5.5 ms/row
```

Queued wall-time fields are computed per row as `durationMs + schedulerWaitMs` before percentile aggregation. They are not produced by adding aggregate averages or percentiles.

**Refinement from the prior refresh.** The previous full run at `14ece18` favored `scanline-stats` by a very small p98 margin (`17.55 ms` vs `17.60 ms` for `scanline-squared`). The rerun at `8ba100d`, after dashboard preload/render fixes and queued-latency reporting, favors `scanline-squared` on both detector avg (`5.50 ms` vs `5.61 ms`) and detector p98 (`17.61 ms` vs `17.85 ms`) while preserving equivalence. The margin remains small, but the latest evidence makes `scanline-squared` the current best safe replacement.

**Conclusion.** `scanline-squared` is the best p98-focused safe replacement for `dense-stats` in the latest full fresh run. It preserved output over all `10,962` comparisons, reduced total flood-control-equivalent time by `12,091.20 ms` (`16.70%`), reduced detector p98 from `20.01 ms` to `17.61 ms`, and improved queued p98 from `21.16 ms` to `19.05 ms`. Indexed lookup variants remain excluded because each produced `17` mismatched views.

### Experiment E — over-narrowed scanline-squared confirmation

**Question.** Does `scanline-squared` still beat `dense-stats` and preserve output when all eliminated flood candidates are disabled? This run was useful but over-narrowed: it did not include `scanline-stats`, so it cannot answer the intended head-to-head confirmation question.

**Report.** `tools/bench/reports/study/study-binary-prefilter-signals.summary.json`, generated `2026-04-25T12:41:57.217Z` from full report `tools/bench/reports/full/study/study-binary-prefilter-signals.json` at `ccbf393033ee687ea031b8aed536139344881bd5`, dirty=`true`.

**Corpus and command.** `203` assets (`60` positive, `143` negative), all `54` binary view identities, `10,962` asset/view comparisons per active detector pattern.

```bash
bun run --cwd tools/bench bench study binary-prefilter-signals \
  --view-set all \
  --refresh-cache
```

The confirmation run measured only `dense-stats`, `run-map`, and `scanline-squared`: `32,886` fresh cache writes instead of `98,658` in the full hybrid bake-off. The run used `12` study workers with flood scheduler limit `6`.

| Variant | Avg | p95 | p98 | p99 | Queued avg / p98 | Saved vs `dense-stats` | Improvement | Output equal | Mismatched views | Decision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |
| `dense-stats` | 7.21 ms | 15.92 ms | 22.86 ms | 29.39 ms | 7.30 / 22.90 ms | — | — | control | 0 | Replaced control. |
| `scanline-squared` | 5.95 ms | 13.50 ms | 20.09 ms | 27.85 ms | 6.04 / 20.32 ms | 13,783.27 ms | 17.44% | `true` | 0 | Confirmed replacement. |

**Scheduler result.** With only two flood patterns active, scheduler wait dropped sharply:

```text
floodSchedulerLimit: 6
total flood scheduler wait: 1,922.02 ms
average flood scheduler wait: ~0.09 ms/row
p98 flood scheduler wait: ~1.6 ms/row
```

**Conclusion.** This run confirms that `scanline-squared` is safe and faster than `dense-stats`, but it does **not** confirm `scanline-squared` over `scanline-stats`. It preserved output over all `10,962` comparisons, reduced flood-control-equivalent time by `13,783.27 ms` (`17.44%`), lowered detector p98 from `22.86 ms` to `20.09 ms`, and lowered queued p98 from `22.90 ms` to `20.32 ms`. The reduced active variant set also substantially lowered scheduler contention, confirming that the broad bake-off should not be used as the ongoing default confirmation workload.

### Experiment F — corrected scanline head-to-head confirmation

**Question.** Between the two safe scanline variants, which should replace `dense-stats` when matcher and eliminated flood variants are disabled?

**Report.** `tools/bench/reports/study/study-binary-prefilter-signals.summary.json`, generated `2026-04-25T12:48:29.797Z` from full report `tools/bench/reports/full/study/study-binary-prefilter-signals.json` at `6a1876bc1052c9bd0d142e4a641b96bb146cc167`, dirty=`true`.

**Corpus and command.** `203` assets (`60` positive, `143` negative), all `54` binary view identities, `10,962` asset/view comparisons per active detector pattern.

```bash
bun run --cwd tools/bench bench study binary-prefilter-signals \
  --view-set all \
  --refresh-cache
```

The corrected confirmation run measured only `dense-stats`, `scanline-stats`, and `scanline-squared`. Matcher patterns and eliminated flood hybrids were disabled, so the run answers the flood-only decision directly with `32,886` fresh cache writes.

| Variant | Avg | p95 | p98 | p99 | Max | Queued avg / p98 | Saved vs `dense-stats` | Improvement | Output equal | Mismatched views | Decision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |
| `dense-stats` | 6.94 ms | 15.01 ms | 20.93 ms | 27.09 ms | 83.91 ms | 8.33 / 22.37 ms | — | — | control | 0 | Replaced control. |
| `scanline-stats` | 5.70 ms | 12.84 ms | 18.50 ms | 25.08 ms | 64.53 ms | 7.21 / 20.31 ms | 13,571.67 ms | 17.83% | `true` | 0 | Safe but slower than `scanline-squared`. |
| `scanline-squared` | 5.64 ms | 12.50 ms | 17.88 ms | 23.96 ms | 59.06 ms | 7.17 / 20.07 ms | 14,309.98 ms | 18.80% | `true` | 0 | Confirmed replacement. |

**Scheduler result.** With three flood patterns active and matcher disabled:

```text
floodSchedulerLimit: 6
total flood scheduler wait: 48,463.58 ms
scanline-stats wait avg / p98: 1.50 / 6.16 ms
scanline-squared wait avg / p98: 1.53 / 6.29 ms
```

**Conclusion.** `scanline-squared` is confirmed as the flood replacement. It preserved output over all `10,962` comparisons, beat `scanline-stats` on every reported detector timing percentile, improved over `dense-stats` by `14,309.98 ms` (`18.80%`), lowered detector p98 from `20.93 ms` to `17.88 ms`, and lowered queued p98 from `22.37 ms` to `20.07 ms`.

### Experiment G — reopened matcher candidates

**Question.** After canonizing `scanline-squared`, can run-pattern-based matcher candidates reduce the now-dominant `run-map` matcher cost while preserving matcher finder signatures?

**Report.** `tools/bench/reports/study/study-binary-prefilter-signals.summary.json`, generated `2026-04-25T12:56:46.811Z` from full report `tools/bench/reports/full/study/study-binary-prefilter-signals.json` at `9eda17274982691ed6dc4aaed2deb154fb42f61b`, dirty=`true`.

**Corpus and command.** `203` assets (`60` positive, `143` negative), all `54` binary view identities, `10,962` asset/view comparisons per active detector pattern.

```bash
bun run --cwd tools/bench bench study binary-prefilter-signals \
  --view-set all \
  --refresh-cache
```

The run measured `scanline-squared` as the fixed flood control, `run-map` as the matcher control, and matcher candidates `run-pattern`, `axis-intersect`, and `shared-runs`. Cache was refreshed: `0` hits, `54,810` writes, and `76,734` old rows purged. The run used `12` study workers with flood scheduler limit `6`.

| Variant | Avg | p95 | p98 | p99 | Max | Saved vs `run-map` | Improvement | Output equal | Mismatched views | Output count | Decision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- |
| `run-map` | 22.62 ms | 55.20 ms | 87.11 ms | 120.12 ms | 467.49 ms | — | — | control | 0 | 97,093 | Canonical matcher. |
| `run-pattern` | 10.16 ms | 36.22 ms | 66.75 ms | 96.89 ms | 412.37 ms | 136,595.52 ms | 55.09% | `false` | 8,760 | 95,317 | Faster but not equivalent; bin as replacement. |
| `axis-intersect` | 9.21 ms | 25.32 ms | 32.89 ms | 44.94 ms | 146.63 ms | 147,043.04 ms | 59.30% | `false` | 8,712 | 37,011 | Faster but not equivalent; bin as replacement. |
| `shared-runs` | 9.99 ms | 36.14 ms | 66.89 ms | 94.21 ms | 380.69 ms | 138,462.63 ms | 55.84% | `false` | 8,760 | 95,317 | Faster but not equivalent; bin this form. |

**Latency context.** `run-map` is the dominant detector cost in this configuration: total matcher control time was `247,957.96 ms` versus fixed flood control time `74,712.27 ms`. The fixed flood control averaged `6.82 ms` with p98 `21.91 ms`; flood scheduler wait was negligible in this matcher-focused run (`83.71 ms` total wait, p98 wait `0.01 ms`).

**Conclusion.** None of the reopened matcher candidates can replace `run-map`. They all improved raw matcher time, but each changed output on most views (`8,712–8,760` mismatches out of `10,962`). `axis-intersect` is the fastest failed candidate, reducing p98 from `87.11 ms` to `32.89 ms`, but its output count collapsed from `97,093` to `37,011`, so the speedup is mostly lost evidence rather than equivalent work. Keep `run-map` as canonical and disable these candidates from the default study. Future matcher work should preserve `run-map` signatures via internal hot-path optimization or explicit prioritization/fallback accounting, not wholesale replacement of center enumeration.

### Experiment H — mixed run-map internals bake-off

**Question.** Can non-gating internal `run-map` matcher processing changes reduce the dominant matcher cost while preserving the exact matcher finder signatures?

**Report.** `tools/bench/reports/study/study-binary-prefilter-signals.summary.json`, generated `2026-04-25T17:52:44.509Z` from full report `tools/bench/reports/full/study/study-binary-prefilter-signals.json` at `e56b06829cc9ec2fe728ab614e523a14ce0584d8`, dirty=`true`.

**Corpus and command.** `203` assets (`60` positive, `143` negative), all `54` binary view identities, `10,962` asset/view comparisons per active detector pattern.

```bash
bun run --cwd tools/bench bench study binary-prefilter-signals \
  --view-set all \
  --refresh-cache
```

The run measured `scanline-squared` as the fixed flood control, `run-map` as the matcher control, and five exact-output matcher candidates. Cache was refreshed: `0` hits, `76,734` writes, and `32,886` old rows purged. The run used `12` study workers with flood scheduler limit `6`.

**Scope correction.** This bake-off accidentally mixed non-gating processing changes with horizontal-failure gating/staging variants. Gating and staged early-abandon patterns belong to a later study phase. For the current processing-only question, only `run-map-u16` is an admissible active candidate; the other rows are advisory evidence and are not eligible for promotion in this phase.

| Variant | Avg | p95 | p98 | p99 | Max | Saved vs `run-map` | Improvement | Output equal | Mismatched views | Decision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |
| `run-map` | 23.82 ms | 57.48 ms | 93.80 ms | 127.15 ms | 534.85 ms | — | — | control | 0 | Current matcher control. |
| `run-map-early-exit` | 20.20 ms | 51.66 ms | 85.02 ms | 117.27 ms | 442.13 ms | 39,669.21 ms | 15.19% | `true` | 0 | Out of scope for this phase; move to later gating study. |
| `run-map-u16` | 20.09 ms | 51.91 ms | 86.25 ms | 122.71 ms | 475.41 ms | 40,972.20 ms | 15.69% | `true` | 0 | Processing-only lead; active for confirmation. |
| `run-map-u16-early-exit` | 16.71 ms | 46.78 ms | 81.96 ms | 113.09 ms | 453.57 ms | 78,010.95 ms | 29.87% | `true` | 0 | Out of scope for this phase; move to later gating study. |
| `run-map-horizontal-first` | 19.76 ms | 52.17 ms | 86.39 ms | 119.70 ms | 452.46 ms | 44,579.76 ms | 17.07% | `true` | 0 | Out of scope for this phase; move to later staging/gating study. |
| `run-map-horizontal-first-u16` | 16.51 ms | 47.86 ms | 82.19 ms | 110.59 ms | 532.71 ms | 80,198.42 ms | 30.71% | `true` | 0 | Out of scope for this phase; move to later staging/gating study. |

**Latency context.** `run-map` remained the dominant detector cost: total matcher control time was `261,150.06 ms` versus fixed flood control time `77,506.15 ms`. The fixed flood control averaged `7.07 ms` with p98 `22.87 ms`; flood scheduler wait was negligible in this matcher-focused run (`50.29 ms` total wait, p98 queued flood `22.91 ms`).

**Conclusion.** The compact run-map representation is the processing-only lead. `run-map-u16` preserved signatures over all `10,962` comparisons, reduced matcher p98 from `93.80 ms` to `86.25 ms`, and cut total matcher-control-equivalent time by `40,972.20 ms` (`15.69%`). The gating/staged variants were faster, but they answer a later early-abandon question and must not drive the current confirmation. Narrow the next confirmation run to `run-map` and `run-map-u16`.

### Experiment I — processing-only matcher representation bake-off

**Question.** Which whole-path matcher representation change best reduces `run-map` matcher cost without changing matcher finder signatures?

**Report.** `tools/bench/reports/study/study-binary-prefilter-signals.summary.json`, generated `2026-04-25T19:16:34.752Z` from full report `tools/bench/reports/full/study/study-binary-prefilter-signals.json` at `3a9efb99180589f47119d4ffa355544e0915c0b7`, dirty=`true`.

**Corpus and command.** `203` assets (`60` positive, `143` negative), all `54` binary view identities, `10,962` asset/view comparisons per active detector pattern.

```bash
bun run --cwd tools/bench bench study binary-prefilter-signals \
  --view-set all
```

This was an incremental run, not a fresh timing confirmation. `run-map` and `scanline-squared` came from cache (`21,924` hits total); the seven processing-only matcher candidates were fresh (`76,734` writes). That makes the run suitable for ranking the fresh candidates against each other and checking equivalence, but the control-vs-candidate percentages should be confirmed with `--refresh-cache` before production promotion.

| Variant | Avg | p95 | p98 | p99 | Max | Improvement vs cached `run-map` | Output equal | Mismatched views | Decision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |
| `run-map` | 23.82 ms | 57.48 ms | 93.80 ms | 127.15 ms | 534.85 ms | — | control | 0 | Cached control. |
| `run-map-u16` | 19.72 ms | 51.50 ms | 85.48 ms | 115.15 ms | 489.96 ms | 17.20% | `true` | 0 | Safe but not lead. |
| `run-map-u16-fill-horizontal` | 18.92 ms | 50.68 ms | 84.93 ms | 116.81 ms | 476.75 ms | 20.58% | `true` | 0 | Safe but not lead. |
| `run-map-scalar-score` | 22.27 ms | 54.08 ms | 87.13 ms | 121.17 ms | 464.42 ms | 6.53% | `true` | 0 | Safe but weak alone. |
| `run-map-u16-scalar-score` | 18.96 ms | 49.17 ms | 83.32 ms | 114.75 ms | 420.19 ms | 20.41% | `true` | 0 | Safe but not lead. |
| `run-map-packed-u16` | 18.27 ms | 49.14 ms | 81.87 ms | 119.58 ms | 528.75 ms | 23.31% | `true` | 0 | Safe but not lead. |
| `run-map-packed-u16-fill-horizontal` | 18.13 ms | 49.45 ms | 82.08 ms | 114.11 ms | 492.75 ms | 23.88% | `true` | 0 | Safe but not lead. |
| `run-map-packed-u16-scalar-score` | 17.33 ms | 47.49 ms | 79.82 ms | 113.59 ms | 443.54 ms | 27.28% | `true` | 0 | Lead; narrow for fresh confirmation. |

**Conclusion.** All processing-only candidates preserved signatures over all `10,962` comparisons. The packed run-map representation is the strongest direction, and `run-map-packed-u16-scalar-score` leads on avg, p95, p98, p99, and total fresh candidate time. The matcher control is canonized to this representation; future timing runs should refresh `run-map` rows because the stable control id now points at the packed/scalar implementation.

### Experiment J — row-scan scalar scoring bake-off

**Question.** Can row-scan's cross-check scoring remove generic tuple/reduction work without changing row-scan finder signatures?

**Report.** `tools/bench/reports/study/study-binary-prefilter-signals.summary.json`, generated `2026-04-25T20:11:35.409Z` from full report `tools/bench/reports/full/study/study-binary-prefilter-signals.json` at `604fbd99`, dirty state not reported by this report format.

**Corpus and command.** `203` assets, all `54` binary view identities, `10,962` asset/view comparisons per active detector pattern.

```bash
bun run --cwd tools/bench bench study binary-prefilter-signals \
  --view-set all
```

This was a row-only detector study phase. Flood, matcher, and dedupe families were disabled so the run measured only the legacy row-scan control plus row-scan internals candidates. The final reporting pass was cache-replayed (`1,218` cache hits, `0` writes), after a prior run recomputed stale control rows that lacked finder signatures.

| Variant | Avg | p95 | p98 | p99 | Max | Improvement vs `row-scan` | Output equal | Mismatched views | Decision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |
| `row-scan` | 6.23 ms | 23.44 ms | 39.56 ms | 60.75 ms | 404.43 ms | — | control | 0 | Legacy row-scan control. |
| `row-scan-scalar-score` | 5.96 ms | 22.43 ms | 39.06 ms | 59.71 ms | 423.97 ms | 4.34% | `true` | 0 | Canonized behind stable `row-scan`. |
| `row-scan-u16` | 10.22 ms | 27.31 ms | 43.17 ms | 61.21 ms | 442.40 ms | -64.13% | `true` | 0 | Binned; run-map construction costs more than it saves for row-scan. |
| `row-scan-u16-scalar-score` | 9.97 ms | 26.64 ms | 42.31 ms | 59.52 ms | 440.71 ms | -60.07% | `true` | 0 | Binned. |
| `row-scan-packed-u16` | 10.11 ms | 27.02 ms | 42.64 ms | 60.42 ms | 421.31 ms | -62.35% | `true` | 0 | Binned. |
| `row-scan-packed-u16-scalar-score` | 9.91 ms | 26.22 ms | 41.60 ms | 59.14 ms | 433.29 ms | -59.15% | `true` | 0 | Binned. |

**Conclusion.** Scalar ratio scoring is a safe row-scan improvement. It preserves row-scan signatures over all `10,962` comparisons, improves total row-scan time by `2,965.83 ms` (`4.34%`), and modestly improves p95/p98/p99. The max tail was slightly worse (`423.97 ms` vs `404.43 ms`), but the p98-focused distribution improved and the implementation is simpler. The run-map-backed row-scan variants are binned because row-scan already walks rows cheaply; building run maps for cross-checks adds more cost than it removes.

## Current variant status

| Variant id | Area | Compared to | Status |
| --- | --- | --- | --- |
| `scanline-squared` | Flood | — | Canonical flood lead: `0` mismatches, `18.80%` faster than `dense-stats`, lower detector p98 and queued p98, and faster than `scanline-stats`. |
| `run-map` | Matcher | — | Canonical matcher control, now backed by packed `u16` run maps plus scalar ratio scoring. Incremental bake-off evidence: `0` mismatches, candidate p98 `79.82 ms` vs cached old-control p98 `93.80 ms`, and `27.28%` faster overall. |
| `row-scan` | Row | — | Canonical row-scan control, now backed by scalar ratio scoring. Row-only bake-off evidence: `0` mismatches, total time `68,260.87 ms → 65,295.04 ms`, p98 `39.56 ms → 39.06 ms`, and `4.34%` faster overall. |
| `dedupe` | Dedupe | — | Active canonical cross-detector dedupe/capping timing family for the historical-control run; logged from proposal-generation finder evidence. |
| `legacy-flood` | Flood | `scanline-squared` | Active historical control for quantifying end-to-end flood gains over the original two-pass connected-component/stat path. |
| `legacy-matcher` | Matcher | `run-map` | Active historical control for quantifying matcher gains over the original pixel-walk cross-check path. |

During the row-scan optimization phase, the default detector-study run is temporarily narrowed to `row-scan` only. Re-enable `scanline-squared`, `run-map`, `dedupe`, `legacy-flood`, and `legacy-matcher` when returning to cross-family overlap/control studies. The stable `row-scan` id now refers to scalar ratio scoring, and its detector-pattern cache version was bumped so old legacy-control rows are not replayed as canonical row-scan timings. The stable `run-map` id refers to the packed/scalar implementation; use `--refresh-cache` for any timing run that needs fresh canonical matcher numbers. Horizontal-failure gating/staging variants remain deferred to a later early-abandon study.

## Inactive and binned variants

Disabled means implemented/cache-retained but not currently queued. Binned means empirically exhausted and should not be re-added without a new hypothesis.

| Variant | Area | Evidence | Decision |
| --- | --- | --- | --- |
| `dense-stats` | Flood | Replaced by `scanline-squared` after corrected head-to-head confirmation. | Binned; retained only as historical evidence. |
| `dense-index` | Flood | Faster than old dense control but `17` mismatched views. | Binned. |
| `dense-squared` | Flood | Safe but weaker than scanline candidates. | Binned. |
| `dense-index-squared` | Flood | Faster than old dense control but `17` mismatched views. | Binned. |
| `scanline-stats` | Flood | Safe but slower than `scanline-squared` in the corrected confirmation. | Binned. |
| `scanline-index` | Flood | Faster than old dense control but `17` mismatched views. | Binned. |
| `scanline-index-squared` | Flood | Fastest old candidate but `17` mismatched views. | Binned. |
| Legacy matcher pixel-walk cross-checks | Matcher | Run-map preserved output over `10,962` comparisons and was `88.93%` faster. | Temporarily active as `legacy-matcher` historical control; not a candidate for promotion. |
| Center-signal / center-pruned matcher hard gate | Matcher | 25-asset post-run-map run had `1,097` mismatched views. | Binned; do not re-add as hard filtering. |
| Row/flood seeded matcher replacement | Matcher | Latest run had `1,104` mismatched views. | Binned as replacement; may only return as prioritization with fallback accounting. |
| Fused normal+inverted matcher traversal | Matcher | Output-equivalent in one run but not fast enough to keep active. | Binned until shared artifacts change the economics. |
| Coarse-grid fallback matcher | Matcher | Several views averaged above `400 ms` even with cache replay. | Binned; fallback cost dominates. |
| Legacy two-pass flood | Flood | Inline stats preserved output and was `64.72%` faster. | Temporarily active as `legacy-flood` historical control; not a candidate for promotion. |
| Filtered-components flood over old path | Flood | Output-equivalent but only `1.66%` faster over old control. | Binned; not enough gain. |
| `inline-flood` | Flood | Superseded by `dense-stats`; targeted `gray:h:i` check showed inline emitted fewer finders than legacy/dense. | Binned; not retained in active detector-pattern cache. |
| `spatial-bin` | Flood | Matched legacy on the targeted divergence but not active after dense/scanline phase. | Binned; not retained in active detector-pattern cache. |
| `run-length-ccl` | Flood | Matched legacy on the targeted divergence but not active after dense/scanline phase. | Binned; not retained in active detector-pattern cache. |
| `run-map-u16` | Matcher | Processing-only bake-off: `0` mismatches, p98 `85.48 ms`, `17.20%` faster than cached old `run-map`. | Safe but weaker than packed/scalar lead; disabled after canonization. |
| `run-map-u16-fill-horizontal` | Matcher | Processing-only bake-off: `0` mismatches, p98 `84.93 ms`, `20.58%` faster than cached old `run-map`. | Safe but weaker than packed/scalar lead; disabled after canonization. |
| `run-map-scalar-score` | Matcher | Processing-only bake-off: `0` mismatches, p98 `87.13 ms`, `6.53%` faster than cached old `run-map`. | Safe but weak alone; disabled after canonization. |
| `run-map-u16-scalar-score` | Matcher | Processing-only bake-off: `0` mismatches, p98 `83.32 ms`, `20.41%` faster than cached old `run-map`. | Safe but weaker than packed/scalar lead; disabled after canonization. |
| `run-map-packed-u16` | Matcher | Processing-only bake-off: `0` mismatches, p98 `81.87 ms`, `23.31%` faster than cached old `run-map`. | Safe but weaker than packed/scalar hybrid; disabled after canonization. |
| `run-map-packed-u16-fill-horizontal` | Matcher | Processing-only bake-off: `0` mismatches, p98 `82.08 ms`, `23.88%` faster than cached old `run-map`. | Safe but weaker than packed/scalar hybrid; disabled after canonization. |
| `run-map-packed-u16-scalar-score` | Matcher | Processing-only bake-off: `0` mismatches, p98 `79.82 ms`, `27.28%` faster than cached old `run-map`. | Canonized behind stable `run-map`; no longer queued as a separate candidate. |
| `row-scan-scalar-score` | Row | Row-only bake-off: `0` mismatches, p98 `39.06 ms` vs `39.56 ms`, `4.34%` faster than legacy row-scan overall. | Canonized behind stable `row-scan`; no longer queued as a separate candidate. |
| `row-scan-u16` | Row | Row-only bake-off: `0` mismatches but avg `10.22 ms` vs control `6.23 ms`, `64.13%` slower overall. | Binned; run-map setup cost dominates row-scan. |
| `row-scan-u16-scalar-score` | Row | Row-only bake-off: `0` mismatches but `60.07%` slower overall. | Binned. |
| `row-scan-packed-u16` | Row | Row-only bake-off: `0` mismatches but `62.35%` slower overall. | Binned. |
| `row-scan-packed-u16-scalar-score` | Row | Row-only bake-off: `0` mismatches but `59.15%` slower overall. | Binned. |
| `run-pattern` | Matcher | Reopened after flood canonization; `55.09%` faster than `run-map` but changed signatures on `8,760` views. | Binned as a replacement; may return only as prioritization/fallback work with explicit recall accounting. |
| `axis-intersect` | Matcher | Reopened after flood canonization; `59.30%` faster than `run-map` but changed signatures on `8,712` views. | Binned as a replacement; may return only as prioritization/fallback work with explicit recall accounting. |
| `shared-runs` | Flood+Matcher | Reopened after flood canonization; `55.84%` faster than `run-map` but changed signatures on `8,760` views. | Binned in this form; future shared artifacts need a new equivalence hypothesis, not this replacement matcher. |

## Candidate rationale

| Candidate | Area | Rationale | Admission bar |
| --- | --- | --- | --- |
| Dense min-x indexed containment lookup | Flood | Bounds gap/stone containment scans by sorted `minX` windows instead of full candidate scans. | Binned after mismatches; may return only with a corrected equivalence hypothesis. |
| Dense squared-distance geometry tests | Flood | Removes `Math.hypot` from ring/gap/stone center checks while preserving thresholds. | Binned after losing to `scanline-squared`. |
| Scanline component labeling | Flood | Processes horizontal spans in bulk while keeping dense-compatible component stats and finder semantics. | Binned after losing to `scanline-squared`. |
| Scanline + indexed/squared hybrids | Flood | Tests span labeling with containment and geometry optimizations. | `scanline-squared` is canonical; indexed variants are binned until mismatches are fixed. |
| Compact run-map arrays | Matcher | Current run maps used four `Uint32Array`s; most images fit axis coordinates in `Uint16Array`, reducing memory bandwidth and allocation size without changing whole-view processing. | Tested and safe, but weaker than packed/scalar; binned after canonization. |
| Horizontal run-map fill | Matcher | Horizontal run-map construction writes contiguous row spans; `TypedArray.fill` can replace per-pixel JS writes without changing work performed. | Tested and safe, but weaker than packed/scalar; binned after canonization. |
| Scalar ratio scoring | Matcher | Cross-check scoring used tuple reduction and expected-array lookup; scalar arithmetic removes generic array operations while preserving the same formula. | Canonized only as part of packed/scalar `run-map`; standalone scalar variants binned. |
| Packed run-map representation | Matcher | Pack 16-bit start/end coordinates into one `Uint32Array` per axis, reducing four map streams to two while preserving full run-map processing. | `run-map-packed-u16-scalar-score` canonized behind stable `run-map`; other packed variants disabled as weaker. |
| Horizontal-failure gating | Matcher | Skipping vertical checks after horizontal failure was faster in the mixed bake-off, but it is an early-abandon pattern rather than whole-processing optimization. | Deferred to a later early-exit study. |
| Horizontal-first staging | Matcher | Building vertical maps only after horizontal survivors was faster in the mixed bake-off, but it changes processing order/gating semantics. | Deferred to a later early-exit/staging study. |
| Run-pattern center matcher | Matcher | Enumerates centers from horizontal `1:1:3:1:1` run patterns instead of arbitrary grid probes. | Binned as a replacement after `8,760` mismatches; may return only with fallback/recall accounting. |
| Axis-run intersection matcher | Matcher | Intersects plausible horizontal and vertical run-pattern centers without a hard center-signal gate. | Binned as a replacement after `8,712` mismatches; may return only with fallback/recall accounting. |
| Shared run-length detector artifacts | Flood+Matcher | One run-length threshold-plane pass could feed both flood CCL and matcher center enumeration. | Current replacement form is binned; a future shared-artifact design needs a new equivalence hypothesis. |

## Report contract

Raw full reports are ignored:

```text
tools/bench/reports/full/study/study-binary-prefilter-signals.json
```

Processed summaries are tracked:

```text
tools/bench/reports/study/study-binary-prefilter-signals.summary.json
```

Processed summaries should include:

- `headline` — lead timing and equality summary;
- `variants` — current leads and genuinely new active candidates only;
- `floodMatrix` — current flood lead and active flood candidates only;
- `detectorLatency` — global detector latency distributions by detector id, including `avgMs`, `p85Ms`, `p95Ms`, `p98Ms`, `p99Ms`, `maxMs`, scheduler-wait fields, and queued wall-time fields when a memory-lane scheduler is active;
- `detectorUnits` — per detector/view latency distributions with the same percentile fields plus job/cache/output/equivalence counts;
- `detectorOverlap` — row/flood/matcher emitted counts, retained counts after cross-detector dedupe, and removal/retention percentages;
- `exploredAvenues` — durable ledger of tested/proposed optimization paths;
- `conclusions` — evidence-backed decisions;
- `questionCoverage` — what the run answers and what remains out of scope.

## Full-run command

Default incremental run:

```bash
bun run --cwd tools/bench bench study binary-prefilter-signals \
  --view-set all
```

Fresh full timing run:

```bash
bun run --cwd tools/bench bench study binary-prefilter-signals \
  --view-set all \
  --refresh-cache
```

Use `--refresh-cache` only when intentionally invalidating all detector-pattern rows for the selected assets. It defeats the normal workflow of reusing cached leads and running only newly added patterns.

## Next work

1. Promote `scanline-squared` behind the production flood control abstraction.
2. Run the next fresh detector timing pass with `--refresh-cache` to repopulate stable `run-map` cache rows with the canonized packed/scalar implementation and measure all four detector families plus `legacy-flood`/`legacy-matcher` historical controls.
3. After the historical-control run, disable `legacy-flood` and `legacy-matcher` again so default studies only retain production detector families.
4. Use `detectorOverlap` from the historical-control run to decide whether `row-scan` or any other detector family contributes retained evidence after dedupe before proposing disablement.
5. Keep horizontal-failure gating/staging out of this phase; design it separately if early-abandon behavior becomes the next matcher question.
4. Sweep flood scheduler limits (`4`, `6`, `8`, `10`, `12`) only after matcher profiling, because flood algorithm ranking is settled.
