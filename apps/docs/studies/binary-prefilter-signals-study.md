# Detector Variant Study: Flood + Matcher

## Abstract

This study tracks detector-only experiments for IronQR finder evidence. It compares detector `FinderEvidence[]` signatures and timing over the approved corpus; it does **not** run proposal generation, clustering, structure, module sampling, or decode.

Settled leads:

1. **Run-map matcher is canonical.** Full-corpus legacy-vs-run-map matcher comparison found `0` mismatched asset/view rows and an `88.93%` matcher-time reduction.
2. **Inline component-stats flood is canonical.** Full-corpus legacy-vs-inline flood comparison found `0` mismatched asset/view rows and a `64.72%` flood-time reduction.

The active study should contain only the current leads plus genuinely new candidates that could beat them. Exhausted references like legacy flood, filtered flood, and center-signal matcher are not active variants.

The study uses detector-pattern cache keys (`patternId + viewId + asset hash`) instead of one coarse whole-asset cache entry. Pattern ids are stable strings like `inline:f:gray:o:n`, so adding a new detector pattern only queues that pattern for each asset/view while cached leads are reused. On startup, the study checks whether all active pattern/view rows for an asset already exist; fully cached assets are reported as cache hits and skip image loading/materialization entirely. Partially cached assets run only missing pattern/view rows. Adding a pattern or adding a view naturally creates missing cache rows; removing a view or binning a pattern stops requiring those rows without deleting historical cache. Asset content changes are invalidated by asset SHA. Retired variants stay in the historical evidence ledger but are excluded from active summary matrices.

## Scope and safety bar

The unit of evidence is an asset/view detector-output comparison. With `--view-set all` on the full corpus, each candidate is compared over:

```text
203 assets × 54 binary views = 10,962 detector-output comparisons
```

A candidate can only move toward production if a full-corpus run reports:

- `outputsEqual === true`
- `mismatchCount === 0`
- runtime improves enough over the current lead to justify the implementation

A faster candidate with mismatches is design input only. Decode pass/fail and false-positive behavior are out of scope for this detector-only study.

## Latency target context

The product-level scanning target is a complete 60 FPS frame decision:

```text
1000 ms / 60 fps = 16.67 ms end-to-end per frame
```

Detector candidates should be judged by whether their savings can materially move the full `scanFrame` path toward that budget. Detector-only wins are still worthwhile when they remove a dominant bottleneck, but small local gains are not enough unless they change end-to-end latency, unlock a larger architecture, or preserve accuracy while reducing variance. Temporal reuse may later relax occasional per-frame work, but this study uses the standalone 16.67 ms target as the optimization yardstick.

## Method

For each selected asset/view:

1. materialize the binary view;
2. run canonical detector leads;
3. run only new candidate detector variants;
4. sort and compare finder signatures:
   - `source`
   - center x/y
   - horizontal/vertical module sizes
   - score
5. record timing and output counts;
6. cache each detector variant independently by variant id and view id.

The first implementation was intentionally broad and exploratory: passive binary signals, proposal generation, matcher candidates, flood timing, and materialization candidates all lived together. That found hotspots, but it made production decisions hard to justify. We refined it into isolated detector-equivalence experiments: matcher first, flood second, then only follow-up candidates against the new controls.

## Experiment design refinement

| Iteration                     | Design                                                                                                                        | Why it changed                                                                               | Evidence produced                                                                                              | Outcome                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 0. Broad detector exploration | Passive signals, materialization timings, detector timings, retired materialization candidates, early matcher/flood variants. | Too many moving parts; good for hotspot discovery, not production validation.                | Detector work dominated; materialization was not the main issue.                                               | Split into focused detector studies.                                        |
| 1. Matcher exploration        | Run-map, center-pruned, seeded, and fused matcher candidates.                                                                 | Prototype variants mixed correctness and headroom; run-map needed a clean legacy comparison. | Center/seed variants mismatched; run-map looked promising.                                                     | Narrowed to legacy matcher vs run-map matcher.                              |
| 2. Matcher equivalence        | Only legacy matcher vs run-map matcher.                                                                                       | Needed a direct regression proof for the default matcher.                                    | `0` mismatches over `10,962` comparisons; `88.93%` faster.                                                     | Run-map matcher canonized; legacy matcher removed.                          |
| 3. Flood equivalence          | Legacy two-pass flood vs inline stats vs filtered component matching.                                                         | Needed to distinguish the large pass-fusion win from smaller matching-filter effects.        | Inline stats: `0` mismatches, `64.72%` faster. Filtered: `0` mismatches, only `1.66%` faster over old control. | Inline flood canonized; legacy/filtered variants retired from active study. |
| 4. Current phase              | Inline flood and run-map matcher leads plus queued, non-exhausted flood/matcher candidates.                                   | Avoid wasting runtime on exhausted candidates without losing the candidate backlog.          | Variant-level cache runs only missing measurements; summaries exclude empirically binned variants.             | Implement queued candidates one by one against cached leads.                |

## Evidence ledger

### Experiment A — matcher cross-check replacement

**Question.** Can run-map-backed cross-checks replace legacy pixel-walk matcher cross-checks without changing matcher finder evidence?

**Corpus.** `203` assets (`60` positive, `143` negative), all `54` binary view identities, `10,962` asset/view comparisons.

| Metric              |  Legacy matcher | Run-map matcher |            Delta |
| ------------------- | --------------: | --------------: | ---------------: |
| Matcher time        | 1,847,272.22 ms |   204,453.47 ms | -1,642,818.75 ms |
| Runtime improvement |               — |          88.93% |                — |
| Output equality     |               — |          `true` |                — |
| Mismatched views    |               — |               0 |                — |

**Conclusion.** Run-map matcher is canonical. The legacy matcher path was removed; the low-level `crossCheck` primitive remains only because row-scan uses it.

### Experiment B — flood label/stat pass fusion

**Question.** Can flood-fill combine connected-component labeling and component-stat collection into one pass without changing flood finder evidence?

**Report.** `tools/bench/reports/study/study-binary-prefilter-signals.summary.json`, generated `2026-04-25T04:53:22.049Z` at `eec0662c7af4e4cd284293ce9bcc123ab425e019`, dirty=`false`.

**Corpus.** `203` assets (`60` positive, `143` negative), all `54` binary view identities, `10,962` asset/view comparisons, cache `0` hits / `203` misses / `203` writes.

| Variant                                    |          Time | Saved vs legacy | Improvement | Output equal | Mismatched views | Decision                  |
| ------------------------------------------ | ------------: | --------------: | ----------: | ------------ | ---------------: | ------------------------- |
| Legacy two-pass flood                      | 443,090.70 ms |               — |           — | control      |                0 | Retired reference.        |
| Inline component-stats flood               | 156,305.84 ms |   286,784.86 ms |      64.72% | `true`       |                0 | Canonical control.        |
| Filtered components over old two-pass path | 435,716.10 ms |     7,374.60 ms |       1.66% | `true`       |                0 | Retired; not enough gain. |

**Conclusion.** Inline component-stats flood is canonical. It eliminates the old second full-image component-stat traversal and preserves flood finder evidence across the full corpus. The filtered-components variant was safe but too small to keep running.

## Active variants

| Variant id      | Area    | Compared to    | Status                                      |
| --------------- | ------- | -------------- | ------------------------------------------- |
| `inline-flood`  | Flood   | —              | Current running flood lead.                 |
| `run-map`       | Matcher | —              | Current running matcher lead.               |
| `dense-stats`   | Flood   | `inline-flood` | First enabled runnable candidate to measure. |

Current phase measures `dense-stats` against the warmed inline-flood control. Other runnable candidates remain implemented and cache-retained, but are disabled from default execution until this candidate is decided.

## Disabled runnable variants

| Variant id        | Area          | Compared to     | Status                                  |
| ----------------- | ------------- | --------------- | --------------------------------------- |
| `run-length-ccl`  | Flood         | `inline-flood`  | Disabled; cache rows are retained.      |
| `spatial-bin`     | Flood         | `inline-flood`  | Disabled; cache rows are retained.      |
| `run-pattern`     | Matcher       | `run-map`       | Disabled; cache rows are retained.      |
| `axis-intersect`  | Matcher       | `run-map`       | Disabled; cache rows are retained.      |
| `shared-runs`     | Flood+Matcher | both leads      | Disabled; cache rows are retained.      |

Active candidate means “included in the default detector-study run and summary matrices.” Disabled means “implemented and retained in cache, but not currently queued.” Binned means “excluded and purged from cache.” These are canonical study ids, not just display labels; they intentionally avoid `control` because today's lead can be replaced by a faster equivalent variant. Dashboard/cache pattern ids additionally abbreviate detector family and view parts: `flood→f`, `matcher→m`, `otsu→o`, `sauvola→s`, `hybrid→h`, `normal→n`, and `inverted→i`.

## Binned / empirically exhausted variants

| Variant                                         | Area    | Evidence                                                                                                                       | Decision                                                                           |
| ----------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Legacy matcher pixel-walk cross-checks          | Matcher | Run-map matcher preserved output over `10,962` comparisons and was `88.93%` faster.                                            | Retired reference; not active.                                                     |
| Center-signal / center-pruned matcher hard gate | Matcher | 25-asset post-run-map run had `1,097` mismatched views.                                                                        | Binned; do not re-add as hard filtering.                                           |
| Row/flood seeded matcher replacement            | Matcher | Latest run had `1,104` mismatched views.                                                                                       | Binned as replacement; may only return as prioritization with fallback accounting. |
| Fused normal+inverted matcher traversal         | Matcher | Output-equivalent in one run but not faster enough to keep active.                                                             | Binned until a shared-artifact architecture changes the economics.                 |
| Coarse-grid fallback matcher                    | Matcher | Dashboard evidence showed several views averaging above `400ms` even with cache replay; fallback cost dominates the candidate. | Binned; do not include in active default runs.                                     |
| Legacy two-pass flood                           | Flood   | Inline stats preserved output and was `64.72%` faster over the full corpus.                                                    | Retired reference; not active.                                                     |
| Filtered-components flood over old path         | Flood   | Output-equivalent but only `1.66%` faster over old control.                                                                    | Binned; not worth active runtime.                                                  |

## Candidate rationale

| Candidate                              | Area          | Rationale                                                                                                     | Admission bar                                                                |
| -------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Run-length connected components        | Flood         | Work scales with horizontal runs rather than pixels; could be the next large improvement after inline stats.  | Must beat inline flood and preserve sorted `FinderEvidence[]` signatures.    |
| Dense typed-array component stats      | Flood         | Replaces object-heavy component stats with dense arrays indexed by component id.                              | Must beat inline flood and preserve sorted `FinderEvidence[]` signatures.    |
| Spatial bins for ring/gap/stone lookup | Flood         | Reduces nested component containment scans if matching dominates after inline stats.                          | Must beat inline flood and preserve sorted `FinderEvidence[]` signatures.    |
| Run-pattern center matcher             | Matcher       | Enumerates centers from `1:1:3:1:1` run patterns instead of arbitrary grid probes.                            | Must beat run-map matcher and preserve sorted `FinderEvidence[]` signatures. |
| Axis-run intersection matcher          | Matcher       | Intersects plausible horizontal and vertical run-pattern centers without the retired hard center-signal gate. | Must beat run-map matcher and preserve sorted `FinderEvidence[]` signatures. |
| Shared run-length detector artifacts   | Flood+Matcher | One run-length threshold-plane pass could feed both flood CCL and matcher center enumeration.                 | Must show combined detector savings, not just local wins.                    |

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
- `detectorLatency` — global detector latency distributions by detector id, including `avgMs`, `p85Ms`, `p95Ms`, `p98Ms`, `p99Ms`, and `maxMs`;
- `detectorUnits` — per detector/view latency distributions with the same percentile fields plus job/cache/output/equivalence counts;
- `exploredAvenues` — durable ledger of tested/proposed optimization paths;
- `conclusions` — evidence-backed decisions;
- `questionCoverage` — what the run answers and what remains out of scope.

## Full-run command

```bash
bun run --cwd tools/bench bench study binary-prefilter-signals \
  --view-set all
```

Use `--refresh-cache` only when intentionally invalidating all detector-pattern rows for the selected assets. It defeats the normal workflow of reusing cached leads and running only newly added patterns.

## Out of scope

- decode success and false positives;
- view ranking / proposal quality;
- clustering budgets;
- production prefilter gating;
- UI/dashboard changes.

Those require separate study designs after detector evidence is settled.
