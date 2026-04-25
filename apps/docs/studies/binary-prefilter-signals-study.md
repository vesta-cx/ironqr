# Detector Variant Study: Flood + Matcher

## Abstract

This study tracks detector-only experiments for IronQR finder evidence. It compares detector `FinderEvidence[]` signatures and timing over the approved corpus; it does **not** run proposal generation, clustering, structure, module sampling, or decode.

Two detector controls are now evidence-backed:

1. **Run-map matcher is canonical.** Full-corpus legacy-vs-run-map matcher comparison found `0` mismatched asset/view rows and an `88.93%` matcher-time reduction.
2. **Inline component-stats flood is canonical.** Full-corpus legacy-vs-inline flood comparison found `0` mismatched asset/view rows and a `64.72%` flood-time reduction.

The current phase keeps those as controls and explores smaller follow-up variants: filtered component matching for flood and center-signal filtering for matcher.

## Scope and safety bar

The unit of evidence is an asset/view detector-output comparison. With `--view-set all` on the full corpus, each candidate is compared over:

```text
203 assets × 54 binary views = 10,962 detector-output comparisons
```

A candidate can only move toward production if a full-corpus run reports:

- `outputsEqual === true`
- `mismatchCount === 0`
- runtime improves enough to justify the implementation

A faster candidate with mismatches is design input only. Decode pass/fail and false-positive behavior are out of scope for this detector-only study.

## Method

For each selected asset/view:

1. materialize the binary view;
2. run canonical detector controls;
3. run candidate detector variants;
4. sort and compare finder signatures:
   - `source`
   - center x/y
   - horizontal/vertical module sizes
   - score
5. record timing and output counts.

The first implementation of this study was too broad: it mixed passive binary signals, proposal generation, matcher variants, flood timing, and retired materialization candidates. That made the dashboard useful for exploration but made the evidence hard to interpret. The study was refined into isolated detector-equivalence experiments:

1. **Matcher equivalence.** Turn off flood/proposal/decode work and compare only legacy matcher vs run-map matcher. This isolated the matcher promotion question and produced a clean full-corpus equality result.
2. **Flood equivalence.** After matcher was settled, turn off matcher/proposal/decode work and compare only flood implementations. This isolated the label/stat fusion question and made inline stats clearly production-worthy.
3. **Follow-up detector variants.** After canonizing run-map matcher and inline flood, restore only small detector candidates against the new controls. Keep proposal/decode work off so timing/equality belongs to the detector under test.

## Experiment design refinement

| Iteration | Design | Problem with prior design | What changed | Resulting evidence |
| --- | --- | --- | --- | --- |
| 0. Passive signal / broad detector exploration | Collected per-view signals, materialization timings, detector timings, and early matcher/flood candidates. | Too many moving parts; useful for finding hotspots, not for validating a production change. | Identified matcher then flood as hot paths and split them into focused studies. | Showed materialization was not the main issue and detector work dominated. |
| 1. Matcher variant exploration | Compared run-map, center-pruned, seeded, and fused matcher candidates. | Some candidates were prototypes or mismatched; run-map needed a clean regression proof against legacy. | Reduced the study to legacy matcher vs run-map matcher only. | Full-corpus `0` mismatches; run-map became canonical. |
| 2. Flood variant exploration | Compared legacy two-pass flood, inline stats, and filtered component matching. | Needed to distinguish the large pass-fusion win from smaller matching-filter wins. | Kept legacy flood as control and measured candidates over all views/assets. | Inline stats had `0` mismatches and `64.72%` speedup; it became canonical. |
| 3. Current follow-up phase | Inline flood and run-map matcher are controls; filtered flood and center-signal matcher are candidates. | We need to know whether smaller variants compose with the new controls. | Report summaries now include `exploredAvenues` and `conclusions` to preserve the evidence trail. | Pending fresh full run. |

## Evidence ledger

### Experiment A — matcher cross-check replacement

**Question.** Can run-map-backed cross-checks replace legacy pixel-walk matcher cross-checks without changing matcher finder evidence?

**Report.** Processed summary generated from the full corpus before legacy matcher cleanup. Command:

```bash
bun run --cwd tools/bench bench study binary-prefilter-signals \
  --view-set all \
  --refresh-cache
```

**Corpus.** `203` assets (`60` positive, `143` negative), all `54` binary view identities, `10,962` asset/view comparisons.

| Metric | Legacy matcher | Run-map matcher | Delta |
| --- | ---: | ---: | ---: |
| Matcher time | 1,847,272.22 ms | 204,453.47 ms | -1,642,818.75 ms |
| Runtime improvement | — | 88.93% | — |
| Output equality | — | `true` | — |
| Mismatched views | — | 0 | — |

**Conclusion.** Run-map matcher is canonical. The legacy matcher exports were removed after this result; the low-level `crossCheck` primitive remains only because row-scan uses it.

### Experiment B — flood label/stat pass fusion

**Question.** Can flood-fill combine connected-component labeling and component-stat collection into one pass without changing flood finder evidence?

**Report.** `tools/bench/reports/study/study-binary-prefilter-signals.summary.json`, generated `2026-04-25T04:53:22.049Z` at `eec0662c7af4e4cd284293ce9bcc123ab425e019`, dirty=`false`.

**Corpus.** `203` assets (`60` positive, `143` negative), all `54` binary view identities, `10,962` asset/view comparisons, cache `0` hits / `203` misses / `203` writes.

| Variant | Time | Saved vs legacy | Improvement | Output equal | Mismatched views |
| --- | ---: | ---: | ---: | --- | ---: |
| Legacy two-pass flood | 443,090.70 ms | — | — | control | 0 |
| Inline component-stats flood | 156,305.84 ms | 286,784.86 ms | 64.72% | `true` | 0 |
| Filtered components over old two-pass path | 435,716.10 ms | 7,374.60 ms | 1.66% | `true` | 0 |

**Conclusion.** Inline component-stats flood is canonical. It eliminates the old second full-image component-stat traversal and preserves flood finder evidence across the full corpus. Filtered component matching was safe in this run but too small to promote on its own; it should be re-tested as a composable candidate on top of the inline flood control.

### Experiment C — active follow-up variants

**Question.** After canonizing run-map matcher and inline flood, are there any smaller detector variants still worth adopting?

**Status.** Implemented in study code; needs a fresh full run.

| Variant id | Area | Control | Hypothesis | Promotion bar |
| --- | --- | --- | --- | --- |
| `inline-flood-control` | Flood | — | Current canonical flood detector. | Control. |
| `legacy-two-pass-flood-reference` | Flood | inline flood | Historical reference should remain equivalent and slower. | 0 mismatches; reference only. |
| `filtered-components-flood-prototype` | Flood | inline flood | Component prefiltering may add a small win on top of inline stats. | 0 mismatches and meaningful extra speedup. |
| `run-map-matcher-control` | Matcher | — | Current canonical matcher detector. | Control. |
| `center-signal-matcher-prototype` | Matcher | run-map matcher | Cheap center checks may reduce matcher cross-checks. | 0 mismatches; prior evidence makes this unlikely. |

## Explored and proposed avenues

| Avenue | Status | Evidence | Decision |
| --- | --- | --- | --- |
| Legacy matcher → run-map matcher | Canonized | `0` mismatches over `10,962` comparisons; `88.93%` faster. | Keep run-map as matcher control; remove legacy matcher path. |
| Legacy two-pass flood → inline component stats | Canonized | `0` mismatches over `10,962` comparisons; `64.72%` faster. | Keep inline stats as flood control. |
| Filtered component flood matching | Follow-up candidate | `0` mismatches over `10,962` comparisons in old-control run; only `1.66%` faster over old two-pass flood path. | Re-test against inline flood; adopt only if it composes cleanly. |
| Center-signal matcher filtering | Exploratory / risky | Earlier center-pruned matcher variants mismatched many views. | Re-test only as evidence; do not promote unless full-corpus equivalent. |
| Run-length connected components | Proposed future avenue | Not implemented. Work would scale with horizontal runs rather than pixels. | Strong next architecture candidate if inline flood remains hot. |
| Dense typed-array component stats | Proposed future avenue | Not implemented. Replaces object/Map-heavy stats with dense arrays by component id. | Likely smaller GC/cache win after inline stats. |
| Spatial bins for ring/gap/stone lookup | Proposed future avenue | Not implemented. Bins components to reduce nested containment scans. | Useful if nested matching dominates after inline stats. |

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

- `headline` — control timing and equality summary;
- `variants` — active detector controls and candidates;
- `floodMatrix` — flood and matcher variant timings/equality for the current detector phase;
- `exploredAvenues` — durable ledger of tested/proposed optimization paths;
- `conclusions` — evidence-backed decisions;
- `questionCoverage` — what the run answers and what remains out of scope.

## Full-run command

```bash
bun run --cwd tools/bench bench study binary-prefilter-signals \
  --view-set all \
  --refresh-cache
```

## Out of scope

- decode success and false positives;
- view ranking / proposal quality;
- clustering budgets;
- production prefilter gating;
- UI/dashboard changes.

Those require separate study designs after detector evidence is settled.
