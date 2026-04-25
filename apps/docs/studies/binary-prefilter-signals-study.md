# Detector Variant Study: Flood + Matcher

## Abstract

This detector-only study evaluates IronQR finder-evidence implementations by comparing sorted `FinderEvidence[]` signatures and timing over the approved corpus. It does **not** measure proposal ranking, clustering, structure fitting, module sampling, decode success, or false positives.

The current evidence supports two detector leads:

1. **Matcher lead: `run-map`.** A full-corpus legacy-vs-run-map matcher comparison found `0` mismatched asset/view rows and an `88.93%` matcher-time reduction.
2. **Flood lead candidate: `scanline-stats`.** The latest full-corpus hybrid run found `scanline-stats` preserved `dense-stats` output over all `10,962` asset/view comparisons while improving flood time by `15.45%` and lowering p98 from `20.12 ms` to `17.55 ms`.

The study has moved through successive controls: legacy matcher → run-map matcher, legacy flood → inline stats flood, inline flood → dense stats, and now dense stats → scanline stats. Retired controls remain in the evidence ledger but should not be active default variants.

## Thesis

A detector candidate can replace the current production lead only if it preserves the sorted `FinderEvidence[]` signature over the full corpus and materially reduces detector latency, especially p98 tail latency.

For the current flood phase, the thesis is:

> Scanline component labeling can replace dense per-pixel flood labeling while preserving `dense-stats` finder evidence and reducing flood detector latency under realistic Worker-throughput execution.

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
| 5. Hybrid flood phase | Dense-stats and run-map leads plus scanline labeling, indexed containment lookup, and squared-distance geometry permutations. | Combine best ideas from prior variants while avoiding fallback/rescue paths. | Full fresh run found scanline-stats and scanline-squared equivalent; indexed variants mismatched. | `scanline-stats` is the p98-focused safe replacement candidate. |
| 6. Throughput instrumentation phase | Real Workers, half-CPU default workers, Worker warmup, sync hot paths, flood memory-lane scheduler, and scheduler-wait reporting. | Multi-worker runs initially measured memory-bandwidth stampede rather than detector cost. | Full `12`-Worker run with flood limit `6` restored flood avg to `~5–7 ms` and reported wait separately. | Keep scheduler-wait telemetry; tune lane limit separately from algorithm ranking. |

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

**Report.** `tools/bench/reports/study/study-binary-prefilter-signals.summary.json`, generated `2026-04-25T12:11:49.629Z` from full report `tools/bench/reports/full/study/study-binary-prefilter-signals.json` at `14ece186a13318f79abfafc15ef42d42ed1b292e`, dirty=`true`.

**Corpus and command.** `203` assets (`60` positive, `143` negative), all `54` binary view identities, `10,962` asset/view comparisons per detector pattern.

```bash
bun run --cwd tools/bench bench study binary-prefilter-signals \
  --view-set all \
  --refresh-cache
```

Cache was refreshed, so timing rows are fresh: `0` hits, `98,658` writes. The run used `12` study workers with flood scheduler limit `6`. Detector timing excludes scheduler wait; scheduler wait is reported separately.

| Variant | Avg | p95 | p98 | p99 | Max | Saved vs `dense-stats` | Improvement | Scheduler wait avg / p98 | Output equal | Mismatched views | Decision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |
| `dense-stats` | 6.67 ms | 14.30 ms | 20.12 ms | 26.73 ms | 65.49 ms | — | — | 0.99 / 5.10 ms | control | 0 | Current control. |
| `dense-index` | 5.89 ms | 11.41 ms | 14.01 ms | 16.23 ms | 53.27 ms | 8,575.77 ms | 11.72% | 1.07 / 5.15 ms | `false` | 17 | Exclude; faster but not equivalent. |
| `dense-squared` | 6.28 ms | 13.66 ms | 18.68 ms | 24.22 ms | 61.59 ms | 4,325.79 ms | 5.91% | 1.09 / 5.38 ms | `true` | 0 | Safe but weaker than scanline candidates. |
| `dense-index-squared` | 5.77 ms | 11.11 ms | 13.47 ms | 15.44 ms | 46.86 ms | 9,892.26 ms | 13.52% | 1.08 / 5.31 ms | `false` | 17 | Exclude; faster but not equivalent. |
| `scanline-stats` | 5.64 ms | 12.57 ms | 17.55 ms | 24.02 ms | 61.27 ms | 11,304.64 ms | 15.45% | 1.10 / 5.36 ms | `true` | 0 | Best p98-focused safe replacement. |
| `scanline-index` | 5.01 ms | 9.70 ms | 11.95 ms | 13.81 ms | 48.25 ms | 18,284.15 ms | 25.00% | 1.09 / 5.33 ms | `false` | 17 | Exclude; faster but not equivalent. |
| `scanline-squared` | 5.51 ms | 12.02 ms | 17.60 ms | 23.19 ms | 57.78 ms | 12,779.23 ms | 17.47% | 1.08 / 5.33 ms | `true` | 0 | Safe; lower average than `scanline-stats`, but marginally worse p98. |
| `scanline-index-squared` | 4.97 ms | 9.61 ms | 11.60 ms | 13.66 ms | 39.56 ms | 18,624.25 ms | 25.46% | 1.08 / 5.33 ms | `false` | 17 | Exclude; fastest but not equivalent. |

**Scheduler result.** Flood scheduling contention is measurable rather than folded into detector timings:

```text
floodSchedulerLimit: 6
total flood scheduler wait: 94,053.72 ms
average flood scheduler wait: ~1.07 ms/row
p98 flood scheduler wait: ~5.3 ms/row
```

This is small compared with the previous memory-bandwidth stampede and should be tuned separately by sweeping scheduler limits.

**Conclusion.** `scanline-stats` is the best p98-focused safe replacement for `dense-stats`. It preserved output over all `10,962` comparisons, reduced total flood-control-equivalent time by `11,304.64 ms` (`15.45%`), and reduced p98 from `20.12 ms` to `17.55 ms`. `scanline-squared` is also safe and has lower average time (`5.51 ms` vs `5.64 ms`) but p98 is slightly worse (`17.60 ms` vs `17.55 ms`), so it does not beat `scanline-stats` under the tail-focused decision rule.

## Current variant status

| Variant id | Area | Compared to | Status |
| --- | --- | --- | --- |
| `run-map` | Matcher | — | Canonical matcher lead. |
| `dense-stats` | Flood | — | Current implementation control; candidate for replacement by `scanline-stats`. |
| `dense-index` | Flood | `dense-stats` | Excluded for now: faster but `17` mismatched views. |
| `dense-squared` | Flood | `dense-stats` | Safe but weaker than scanline candidates. |
| `dense-index-squared` | Flood | `dense-stats` | Excluded for now: faster but `17` mismatched views. |
| `scanline-stats` | Flood | `dense-stats` | Best safe replacement candidate: `0` mismatches, `15.45%` faster, lower p98. |
| `scanline-index` | Flood | `dense-stats` | Excluded for now: faster but `17` mismatched views. |
| `scanline-squared` | Flood | `dense-stats` | Safe candidate: `0` mismatches and `17.47%` faster, but p98 is marginally worse than `scanline-stats`. |
| `scanline-index-squared` | Flood | `dense-stats` | Excluded for now: fastest but `17` mismatched views. |

## Disabled and binned variants

Active means included in the default detector-study run and summary matrices. Disabled means implemented/cache-retained but not currently queued. Binned means empirically exhausted and should not be re-added without a new hypothesis.

| Variant | Area | Evidence | Decision |
| --- | --- | --- | --- |
| Legacy matcher pixel-walk cross-checks | Matcher | Run-map preserved output over `10,962` comparisons and was `88.93%` faster. | Retired reference. |
| Center-signal / center-pruned matcher hard gate | Matcher | 25-asset post-run-map run had `1,097` mismatched views. | Binned; do not re-add as hard filtering. |
| Row/flood seeded matcher replacement | Matcher | Latest run had `1,104` mismatched views. | Binned as replacement; may only return as prioritization with fallback accounting. |
| Fused normal+inverted matcher traversal | Matcher | Output-equivalent in one run but not fast enough to keep active. | Binned until shared artifacts change the economics. |
| Coarse-grid fallback matcher | Matcher | Several views averaged above `400 ms` even with cache replay. | Binned; fallback cost dominates. |
| Legacy two-pass flood | Flood | Inline stats preserved output and was `64.72%` faster. | Retired reference. |
| Filtered-components flood over old path | Flood | Output-equivalent but only `1.66%` faster over old control. | Binned; not enough gain. |
| `inline-flood` | Flood | Superseded by `dense-stats`; targeted `gray:h:i` check showed inline emitted fewer finders than legacy/dense. | Retired reference. |
| `spatial-bin` | Flood | Matched legacy on the targeted divergence but not active after dense/scanline phase. | Cache-retained historical reference. |
| `run-length-ccl` | Flood | Matched legacy on the targeted divergence but not active after dense/scanline phase. | Cache-retained historical reference. |
| `run-pattern` | Matcher | Implemented but disabled after run-map canonization. | Cache-retained disabled variant. |
| `axis-intersect` | Matcher | Implemented but disabled after run-map canonization. | Cache-retained disabled variant. |
| `shared-runs` | Flood+Matcher | Requires a combined shared-artifact study, not just local detector wins. | Cache-retained disabled variant. |

## Candidate rationale

| Candidate | Area | Rationale | Admission bar |
| --- | --- | --- | --- |
| Dense min-x indexed containment lookup | Flood | Bounds gap/stone containment scans by sorted `minX` windows instead of full candidate scans. | Must beat `dense-stats` and preserve sorted `FinderEvidence[]` signatures. Current implementation fails equivalence. |
| Dense squared-distance geometry tests | Flood | Removes `Math.hypot` from ring/gap/stone center checks while preserving thresholds. | Must beat `dense-stats` and preserve signatures. Safe but smaller win than scanline candidates. |
| Scanline component labeling | Flood | Processes horizontal spans in bulk while keeping dense-compatible component stats and finder semantics. | Must beat `dense-stats` and preserve signatures. Current best: `scanline-stats`. |
| Scanline + indexed/squared hybrids | Flood | Tests span labeling with containment and geometry optimizations. | Indexed variants must fix mismatches before reconsideration. |
| Run-pattern center matcher | Matcher | Enumerates centers from `1:1:3:1:1` run patterns instead of arbitrary grid probes. | Must beat `run-map` and preserve signatures. Disabled. |
| Axis-run intersection matcher | Matcher | Intersects plausible horizontal and vertical run-pattern centers without a hard center-signal gate. | Must beat `run-map` and preserve signatures. Disabled. |
| Shared run-length detector artifacts | Flood+Matcher | One run-length threshold-plane pass could feed both flood CCL and matcher center enumeration. | Requires combined detector savings, not local wins. Disabled pending separate design. |

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

1. Promote `scanline-stats` behind the flood control abstraction and run a clean full-corpus confirmation.
2. Sweep flood scheduler limits (`4`, `6`, `8`, `10`, `12`) to tune throughput versus scheduler wait without changing algorithm rankings.
3. Investigate the `17` indexed-lookup mismatches. Indexed variants are fast enough to revisit only if equivalence can be restored.
4. Revisit shared run-length artifacts as a separate combined flood+matcher study after the flood control is settled.
