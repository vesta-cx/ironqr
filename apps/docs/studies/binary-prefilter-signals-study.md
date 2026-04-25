# Legacy vs Run-Map Matcher Accuracy Study

## Problem / question

The matcher cross-check implementation changed from repeated pixel walking to row/column run-map-backed cross-checks. The 25-asset smoke study showed a large matcher speedup with equal matcher finder signatures, but that sample is not enough to close regression risk for a default detector-path change.

> Does the run-map matcher produce the same matcher `FinderEvidence[]` as the legacy pixel-walk matcher across the full corpus and all binary view identities?

This study is now intentionally narrow. It is not a prefilter-gating study, not a decode-capability study, and not a broad detector-optimization shootout. Center pruning, row/flood-seeded rescue, and fused-polarity traversal are turned off until we intentionally return to those detector patterns.

## Hypothesis / thesis

Run-map-backed cross-checks should be output-equivalent to the legacy pixel-walk matcher because they answer the same horizontal/vertical dark-light run-length queries from precomputed axis runs. If output signatures match across every asset/view, the run-map matcher can remain the production matcher control and matcher work can be considered settled for this PR.

Null hypothesis: run-map-backed cross-checks change matcher finder output on at least one corpus asset/view and need targeted investigation before the matcher promotion is treated as validated.

## Designed experiment / study

Run `binary-prefilter-signals` over all 54 binary view identities. For each asset/view:

1. Materialize the selected `BinaryView`.
2. Run only `detectMatcherFinders(...)`, the current run-map-backed matcher control.
3. Independently run only `detectMatcherFindersLegacy(...)` on the same `BinaryView`.
4. Compare sorted matcher finder signatures:
   - `source`
   - center x/y
   - module sizes
   - score
5. Record timing for the run-map matcher control and the legacy matcher control.
6. Report only the legacy-vs-run-map control comparison in the processed summary.

The study does not run proposal generation for this mode. It intentionally does not run row-scan, flood-fill, cross-detector dedupe, triple assembly, or proposal construction.

Detector variants intentionally disabled for this run:

- center-pruned matcher;
- row/flood-seeded matcher rescue;
- fused normal+inverted polarity traversal;
- production prefilter threshold sweeps.

Those are optimization questions. This study is only an accuracy/equivalence validation for the matcher cross-check promotion.

## Metrics table

| Metric | Unit | Source | Decision use |
| --- | --- | --- | --- |
| Run-map matcher duration | ms | production proposal-view matcher timing | Confirms production matcher cost. |
| Legacy matcher duration | ms | study-side legacy matcher timing | Measures old control cost. |
| Legacy vs run-map output equality | boolean | finder signature comparison | Primary pass/fail criterion. |
| Legacy vs run-map mismatch count | view rows | finder signature comparison | Must be zero for promotion validation. |
| Matcher-only detector duration | ms | run-map matcher timing | Equals run-map matcher duration for this focused mode. |
| Materialization duration | ms | scalar/binary timing spans | Context for study overhead. |

## Decision rule

Treat the run-map matcher promotion as validated if a full-corpus run reports:

- `matcherMatrix.controlComparison.legacyVsRunMapOutputsEqual === true`
- `matcherMatrix.controlComparison.legacyVsRunMapMismatchCount === 0`

If mismatches are nonzero:

1. inspect the mismatched asset/view rows in the full report;
2. classify whether differences are benign scoring/order noise or real finder geometry changes;
3. add targeted unit/corpus coverage before relying on run-map as the production control.

Do not make production decisions about decode accuracy, false positives, prefilter thresholds, center pruning, seeded rescue, or fused polarity from this study. Those need separate study designs.

## Implementation checklist

- [x] Keep all 54 binary view identities available with `--view-set all`.
- [x] Keep run-map matcher as the production control path.
- [x] Re-run the legacy pixel-walk matcher per asset/view.
- [x] Compare matcher finder signatures against the run-map control.
- [x] Emit processed summary fields for the legacy-vs-run-map control comparison.
- [x] Disable center-prune, row/flood-seeded, and fused-polarity matcher variants for this study direction.
- [ ] Run the full 203-asset corpus.

## Reports

Raw full reports are ignored and live under:

```text
tools/bench/reports/full/study/study-binary-prefilter-signals.json
```

The durable processed summary lives under:

```text
tools/bench/reports/study/study-binary-prefilter-signals.summary.json
```

The processed summary should be the first artifact to read. It includes:

- `headline`: detector, flood, run-map matcher, legacy matcher, equality, mismatch count;
- `variants`: only `legacy-matcher-control` and `run-map-matcher-control`;
- `matcherMatrix.controlComparison`: run-map/legacy timings, equality, mismatch count, saved ms, improvement %;
- `detectorBreakdown`: expected to be zeroed for row-scan/flood/dedupe in this matcher-only mode;
- `questionCoverage`: states that matcher equivalence is answered and decode/false-positive questions are out of scope.

## 25-asset smoke checkpoint

Source processed report:

```text
tools/bench/reports/study/study-binary-prefilter-signals.summary.json
```

Run metadata:

- generated: `2026-04-25T03:24:17.542Z`
- commit: `519b62e02ab161891de6d2e40360a26903f7f06e`
- command: `bench study binary-prefilter-signals --view-set all --refresh-cache --max-assets 25`
- corpus sample: 25 assets, 8 positive, 17 negative
- cache: 0 hits, 25 misses, 25 writes
- config: `{ focus: "binary-prefilter-signals", viewSet: "all", decode: false }`

Headline evidence:

| Metric | Value |
| --- | ---: |
| Detector time | 75,698.18 ms |
| Flood time | 44,299.29 ms (historical smoke only; disabled in current matcher-only code) |
| Run-map matcher time | 22,477.26 ms |
| Legacy matcher time | 239,995.51 ms |
| Run-map saved time | 217,518.25 ms |
| Run-map improvement vs legacy | 90.63% |
| Legacy vs run-map output equality | `true` |
| Legacy vs run-map mismatched views | 0 |

Interpretation:

- The smoke run strongly supports the run-map matcher promotion: `0` mismatched matcher view rows across `25 × 54 = 1,350` asset/view rows.
- The legacy matcher is roughly an order of magnitude slower than the run-map matcher on this sample.
- Flood-fill is now the main detector bottleneck, not matcher: `44.3s / 75.7s = 58.5%` of detector time.
- This run does not validate decode accuracy or false-positive behavior because `decode=false`.

## Full-run plan

Run the full corpus with no `--max-assets`:

```bash
bun run --cwd tools/bench bench study binary-prefilter-signals \
  --view-set all \
  --refresh-cache
```

Expected full-run decision:

- If mismatch count is zero, keep run-map matcher as the production/default matcher and stop matcher work for this PR.
- If mismatch count is nonzero, inspect mismatched assets/views before shipping the matcher promotion as validated.
- Regardless of matcher result, treat flood/component labeling as the next detector-optimization area once matcher equivalence is settled.

## Out of scope / future studies

The following remain intentionally out of scope for the full-blast matcher-equivalence run:

- center-pruned matcher gating or prioritization;
- row/flood-seeded matcher rescue;
- fused normal+inverted matcher traversal;
- binary prefilter threshold sweeps;
- decode success / false-positive proof;
- component-label reuse and flood-fill optimization.

When we return to detector optimization, create separate study designs for flood/component labeling and any matcher rescue strategy. Do not overload this equivalence run with those questions.
