# Detector Variant Study: Flood + Matcher

## Abstract

This study tracks detector-only experiments for IronQR finder evidence. It compares detector `FinderEvidence[]` signatures and timing over the approved corpus; it does **not** run proposal generation, clustering, structure, module sampling, or decode.

Settled controls:

1. **Run-map matcher is canonical.** Full-corpus legacy-vs-run-map matcher comparison found `0` mismatched asset/view rows and an `88.93%` matcher-time reduction.
2. **Inline component-stats flood is canonical.** Full-corpus legacy-vs-inline flood comparison found `0` mismatched asset/view rows and a `64.72%` flood-time reduction.

The active study should contain only the current controls plus genuinely new candidates that could beat them. Exhausted references like legacy flood, filtered flood, and center-signal matcher are not active variants.

The study uses detector-variant cache keys (`variantId + viewId + asset hash`) instead of one coarse whole-asset cache entry. Adding a new variant should run only that variant for each asset/view while reusing cached measurements for the current control. Retired variants stay in the historical evidence ledger but are excluded from active summary matrices.

## Scope and safety bar

The unit of evidence is an asset/view detector-output comparison. With `--view-set all` on the full corpus, each candidate is compared over:

```text
203 assets × 54 binary views = 10,962 detector-output comparisons
```

A candidate can only move toward production if a full-corpus run reports:

- `outputsEqual === true`
- `mismatchCount === 0`
- runtime improves enough over the current control to justify the implementation

A faster candidate with mismatches is design input only. Decode pass/fail and false-positive behavior are out of scope for this detector-only study.

## Method

For each selected asset/view:

1. materialize the binary view;
2. run canonical detector controls;
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

| Iteration | Design | Why it changed | Evidence produced | Outcome |
| --- | --- | --- | --- | --- |
| 0. Broad detector exploration | Passive signals, materialization timings, detector timings, retired materialization candidates, early matcher/flood variants. | Too many moving parts; good for hotspot discovery, not production validation. | Detector work dominated; materialization was not the main issue. | Split into focused detector studies. |
| 1. Matcher exploration | Run-map, center-pruned, seeded, and fused matcher candidates. | Prototype variants mixed correctness and headroom; run-map needed a clean legacy comparison. | Center/seed variants mismatched; run-map looked promising. | Narrowed to legacy matcher vs run-map matcher. |
| 2. Matcher equivalence | Only legacy matcher vs run-map matcher. | Needed a direct regression proof for the default matcher. | `0` mismatches over `10,962` comparisons; `88.93%` faster. | Run-map matcher canonized; legacy matcher removed. |
| 3. Flood equivalence | Legacy two-pass flood vs inline stats vs filtered component matching. | Needed to distinguish the large pass-fusion win from smaller matching-filter effects. | Inline stats: `0` mismatches, `64.72%` faster. Filtered: `0` mismatches, only `1.66%` faster over old control. | Inline flood canonized; legacy/filtered variants retired from active study. |
| 4. Current phase | Inline flood and run-map matcher controls only, until a new better candidate is implemented. | Avoid wasting runtime on exhausted controls/candidates. | Variant-level cache runs only missing measurements; summaries exclude binned variants. | Add only new candidates that can plausibly beat the running lead. |

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
| Inline component-stats flood | 156,305.84 ms | 286,784.86 ms | 64.72% | `true` | 0 | Canonical control. |
| Filtered components over old two-pass path | 435,716.10 ms | 7,374.60 ms | 1.66% | `true` | 0 | Retired; not enough gain. |

**Conclusion.** Inline component-stats flood is canonical. It eliminates the old second full-image component-stat traversal and preserves flood finder evidence across the full corpus. The filtered-components variant was safe but too small to keep running.

## Active variants

| Variant id | Area | Control | Status |
| --- | --- | --- | --- |
| `inline-flood-control` | Flood | — | Current running lead. |

There are currently no active candidates. Add one only when it has a credible path to outperform inline flood or run-map matcher.

## Proposed future avenues

| Avenue | Area | Rationale | Admission bar |
| --- | --- | --- | --- |
| Run-length connected components | Flood | Work scales with horizontal runs rather than pixels; could be the next large improvement after inline stats. | Implement as a candidate and compare against inline flood over all views/assets. |
| Dense typed-array component stats | Flood | Replaces object-heavy component stats with dense arrays indexed by component id. | Must beat inline flood and preserve output. |
| Spatial bins for ring/gap/stone lookup | Flood | Reduces nested component containment scans if matching dominates after inline stats. | Must beat inline flood and preserve output. |
| New matcher center enumeration | Matcher | A fundamentally different candidate-center source may reduce run-map matcher work without hard filtering. | Must beat run-map matcher and preserve output; avoid old center-signal hard gate. |

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
- `variants` — current controls and genuinely new active candidates only;
- `floodMatrix` — current flood control and active flood candidates only;
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
