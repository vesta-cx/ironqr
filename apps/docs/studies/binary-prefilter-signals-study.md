# Detector Variant Study: Flood + Matcher

## Abstract

This study tracks detector-only experiments for IronQR finder evidence. It does **not** run proposal generation, clustering, structure, module sampling, or decode. A candidate is useful only when it preserves `FinderEvidence[]` signatures against the current control and reduces runtime.

Two results are already settled:

1. **Run-map matcher is canonical.** Full-corpus legacy-vs-run-map matcher comparison had zero mismatched asset/view rows.
2. **Inline component-stats flood is canonical.** Full-corpus flood comparison showed zero mismatches and a 64.72% speedup over the legacy two-pass flood implementation.

The current study phase keeps those as controls and explores small follow-up detector variants.

## Current controls

| Detector | Canonical control | Why |
| --- | --- | --- |
| Matcher | `detectMatcherFinders` using run-map cross-checks | Full-corpus output equality vs legacy matcher; large runtime reduction. |
| Flood | `detectFloodFinders` using inline component stats | Full-corpus output equality vs legacy two-pass flood; 64.72% runtime reduction. |

## Active research question

> After canonizing run-map matcher and inline flood, are there additional detector variants that preserve finder evidence while reducing detector time?

The unit of decision is an asset/view detector-output comparison. For the full corpus and `--view-set all`, that is `203 × 54 = 10,962` comparisons per candidate.

## Method

For each selected asset/view:

1. materialize the binary view;
2. run canonical detector controls;
3. run candidate detector variants;
4. compare sorted finder signatures:
   - `source`
   - center x/y
   - horizontal/vertical module sizes
   - score
5. record timing and output counts.

A candidate passes the safety bar only when `outputsEqual === true` and `mismatchCount === 0` on the full corpus.

## Explored avenues

| Avenue | Status | Evidence | Decision |
| --- | --- | --- | --- |
| Legacy matcher → run-map matcher | Canonized | 0 full-corpus mismatches; run-map was much faster. | Keep run-map as matcher control. |
| Legacy two-pass flood → inline component stats | Canonized | 0 full-corpus mismatches; 443,090.70ms → 156,305.84ms, 64.72% faster. | Keep inline stats as flood control. |
| Filtered component flood matching | Follow-up candidate | 0 full-corpus mismatches in prior run; only 1.66% faster over old two-pass flood path. | Re-test against inline flood; adopt only if it composes cleanly. |
| Center-signal matcher filtering | Exploratory / risky | Earlier center-pruned matcher variants mismatched many views. | Re-test only as evidence; do not promote unless full-corpus equivalent. |
| Run-length connected components | Proposed future avenue | Not implemented in current study. | Strong next architecture candidate if inline flood remains hot. |
| Dense typed-array component stats | Proposed future avenue | Not implemented in current study. | Likely smaller GC/cache win after inline stats. |
| Spatial bins for ring/gap/stone lookup | Proposed future avenue | Not implemented in current study. | Useful if nested component matching dominates after inline stats. |

## Active variants in the next run

| Variant id | Area | Control | Hypothesis | Safety criterion |
| --- | --- | --- | --- | --- |
| `inline-flood-control` | Flood | — | Current canonical flood detector. | Control. |
| `legacy-two-pass-flood-reference` | Flood | inline flood | Historical reference should remain equivalent and slower. | 0 mismatches. |
| `filtered-components-flood-prototype` | Flood | inline flood | Component prefiltering may add a small win on top of inline stats. | 0 mismatches. |
| `run-map-matcher-control` | Matcher | — | Current canonical matcher detector. | Control. |
| `center-signal-matcher-prototype` | Matcher | run-map matcher | Cheap center checks may reduce matcher cross-checks. | 0 mismatches; prior evidence makes this unlikely. |

## Decision rule

Promote a candidate only if a full-corpus run reports:

- output equality is `true`;
- mismatch count is `0`;
- runtime improves over the current control by enough to justify the code.

If a candidate is faster but mismatches, keep it as design input only. If a candidate is equivalent but only marginally faster, leave it in study code unless it simplifies production.

## Report contract

Raw full reports are ignored:

```text
tools/bench/reports/full/study/study-binary-prefilter-signals.json
```

Processed summaries are tracked:

```text
tools/bench/reports/study/study-binary-prefilter-signals.summary.json
```

The processed summary should contain:

- `headline` — current control timing and equality summary;
- `variants` — active detector controls and candidates;
- `floodMatrix` — flood and matcher variant timings/equality for this detector-study phase;
- `exploredAvenues` — durable ledger of tested/proposed optimization paths;
- `conclusions` — short evidence-backed decisions;
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
