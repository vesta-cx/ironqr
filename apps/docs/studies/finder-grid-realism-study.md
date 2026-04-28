# Finder Grid Realism Study

## Problem / question

Hard timing-corridor rejection failed because it sampled a crude finder-center corridor instead of asking whether a finder triple can support a realistic QR grid. This study asks whether projective/trigonometric finder-grid realism signals can rank or filter unrealistic finder triples before decode, and whether those signals can be measured cheaply without running the decode cascade.

## Hypothesis / thesis

A plausible QR finder triple should support a coherent QR-grid hypothesis: the observed finder centers, finder module sizes, local finder aspect/skew, inferred version, projected bounds, quiet zone, and grid-relative timing row/column should agree under a projective transform or a clearly explainable warp residual. The null hypothesis is that these signals do not separate realistic from unrealistic triples without losing positive proposal coverage.

## Designed experiment / study

Run a proposal/frontier-only signal study by default:

```bash
bun run bench study finder-grid-realism --no-decode --refresh-cache
```

The `--no-decode` mode is the fast path. It should stop after proposal generation, ranking, clustering, representative selection, and grid-realism scoring. It must not run the decode cascade.

Optional decode-confirmation mode:

```bash
bun run bench study finder-grid-realism --refresh-cache
```

Decode mode should be used only after `--no-decode` identifies a promising signal/ranking/filter candidate.

Defaults:

```text
detectorPolicy=no-flood
rankingVariant=timing-heavy
clusterRepresentativeVariant=proposal-score
proposalViewIds=listDefaultBinaryViewIds()
maxProposals=24
maxClusterRepresentatives=1
maxViews=54
noDecode=true when --no-decode is passed
```

## Policy variants

Grid-realism checks are a dependency graph, not independent scanner policies:

```text
geometry hypothesis
→ projective plausibility
→ module/local-scale consistency
→ projected bounds sanity
→ grid-relative timing evidence
→ combined realism score / ranking policy
```

The study compares full replacement ranking objectives with and without that coherent realism pipeline. Component scores are diagnostics nested under each policy row; objective variants are different ways to combine the same dependent signal graph.

| Variant | Purpose |
| --- | --- |
| `baseline` | Existing proposal/ranking/cluster representative order with no added grid-realism ordering. |
| `grid-realism-ranking` | Phase-locked semantic composite objective: finder template, timing corridor, module consistency, quiet zone, and projective/bounds sanity, with proposal score only as tie-breaker. |
| `realism-phase-locked` | Alias/candidate for the same phase-locked semantic composite, kept explicit for report readability. |
| `realism-module-heavy` | Full replacement objective that emphasizes module/local-scale consistency after finder/timing semantic support. |
| `realism-timing-heavy` | Optional full replacement objective that emphasizes phase-locked grid-relative timing. Not enabled by default. |
| `realism-decode-likelihood` | Full replacement objective that rewards finder template, timing corridor, module consistency, and quiet zone support. |
| `realism-low-risk` | Full replacement objective that uses finder/timing/quiet-zone failures as severe penalties, then ranks by semantic support. |
| `realism-geomean` | Full replacement multiplicative objective requiring multiple semantic components to be decent. |
| `realism-lexicographic` | Full replacement objective that prioritizes finder/timing sanity pass, then finder, module, and timing scores. |
| `realism-penalty-only` | Optional full replacement badness objective. Not enabled by default. |
| `grid-realism-ranking-no-timing` | Optional ablation to quantify timing's contribution to the original composite. Not enabled by default. |
| `grid-realism-ranking-no-module` | Optional ablation to quantify module-consistency's contribution to the original composite. Not enabled by default. |

## Fast `--no-decode` report metrics

| Metric | Unit | Decision use |
| --- | --- | --- |
| Positive assets with proposals | assets | Proposal coverage guard. |
| Negative assets with proposals | assets | Proposal flood / false-frontier behavior. |
| Proposal count | proposals | Frontier size. |
| Cluster count | clusters | Cluster frontier size. |
| Representative count | representatives | Decode-frontier proxy. |
| Lost positive proposal assets | asset ids | Hard safety guard for proposal-only mode. |
| Gained/lost proposal signatures | count / asset ids | Exact effect of ranking/filtering. |
| First changed representative rank | rank | Whether realism actually changes decode-frontier order. |
| Projective realism diagnostic distribution | score | Whether the shared geometry hypothesis is plausible. |
| Module consistency diagnostic distribution | score | Perspective/local-scale coherence inside the full policy. |
| Finder-pattern diagnostic distribution | score | 7x7 finder template plus separator support after grid unwarp. |
| Phase-locked grid timing diagnostic distribution | score | Row 6 / col 6 timing evidence with QR phase, axis agreement, run quality, and jitter penalty. |
| Quiet-zone grid diagnostic distribution | score | Quiet-zone support sampled in grid coordinates. |
| Combined ranking score distribution by label | score | Positive/negative separation of the full policy. |
| Per-policy runtime | ms | Whether the full policy is cheap enough before decode. |

## Frontier provenance and threshold-sweep metrics

Decode-mode reports include per-representative frontier evidence so the study answers whether a score can reduce scanner work without hiding valid decodes:

| Field | Unit | Decision use |
| --- | --- | --- |
| `frontier[].binaryViewId` | view id | Which materialized views supply kept/dropped representatives and successful decodes. |
| `frontier[].clusterRank` | rank | Which clusters lead to valid decodes or false positives. |
| `frontier[].representativeRank` | rank | Whether valid decodes come from the selected cluster representative or later representatives. |
| `frontier[].variantRank` / `baselineRank` | rank | Rank movement caused by the realism policy. |
| `frontier[].score` | score | Threshold decision input. |
| `frontier[].components` | score vector | Which realism signals explain kept/dropped work. |
| `decode.attempts[]` | per representative | Concrete decode attempts, success, false-positive, expected-text match, and score at the attempted representative. |
| `summary.thresholdSweeps[]` | threshold table | For each score threshold, reports representatives kept/dropped, decode attempts kept/avoided, positives lost, and false positives removed. |
| `summary.variants[].decodedProvenance` | distributions | View counts, proposal/cluster/representative ranks, score distributions, and component averages for matched positives and false positives. |

Threshold sweeps simulate applying `score >= threshold` to the scored frontier and replaying the representatives that were actually attempted by the decode run. They are meant to answer:

```text
how many representatives/decode attempts would this threshold avoid?
how many positive decoded assets would it lose?
how many false-positive assets would it remove?
which views/proposals/clusters/reps produced the kept/lost outcomes?
```

## Optional decode-confirmation metrics

Only for candidates that pass `--no-decode`:

| Metric | Unit | Decision use |
| --- | --- | --- |
| Positive decoded assets | assets | Primary recall guard. |
| False-positive assets | assets | Safety guard. |
| Decode attempts | count | Work reduction. |
| Scan/decode/module-sampling timing | ms | Cost attribution. |
| Lost/gained decoded positives | asset ids | Explain outcome changes. |

## Signal definitions

### Projective realism

For each oriented finder triple hypothesis, infer canonical QR finder-center coordinates:

```text
TL center = (3.5, 3.5)
TR center = (size - 3.5, 3.5)
BL center = (3.5, size - 3.5)
```

Estimate version/grid size from finder spacing and module size. Build a projective or affine+perspective grid hypothesis. Score:

```text
convexity
non-crossing edges
reasonable projected area
reasonable module pitch
bottom-right prediction sanity
image bounds tolerance
version agreement between arms
```

Do not reject merely because the observed finder centers are not a right triangle; perspective can make them non-right-angled in image space.

### Module-size realism

Compare observed finder module sizes to the local scale predicted by the inferred grid:

```text
observed moduleSize vs predicted local module scale
observed hModuleSize/vModuleSize vs projected local basis lengths
scale gradient consistency across TL/TR/BL
version estimates from horizontal and vertical arms
```

The question is whether an unwarp can sensibly explain the finder distortions, not whether all module sizes are equal.

### Grid timing score

Use grid coordinates, not finder-center corridor offsets:

```text
row 6: sample (x, 6) for x = 8..size-9
col 6: sample (6, y) for y = 8..size-9
```

Score alternating timing modules with tolerance:

```text
phase-insensitive dark/light match
small local offset jitter
best of nearby submodule positions
fail-open when geometry confidence is low
```

### Warp residual classification

Record whether residuals look:

```text
planar-like
horizontal-cylinder-like
vertical-cylinder-like
radial-like
local-mesh-like
ambiguous
```

This is classification evidence only. It should feed later warp-rescue issues, not hard rejection in this slice.

## Decision rule

For `--no-decode`, a candidate signal/ranking/filter can advance to decode confirmation only if:

```text
lost positive proposal assets = []
positive proposal coverage delta >= 0
negative proposal/frontier behavior does not regress materially
representative or cluster frontier improves materially, OR signal clearly separates positives from noisy negatives
signal runtime is small relative to proposal generation
```

Hard rejection is allowed to advance only if it is very conservative:

```text
multiple independent realism checks fail
coronatest remains covered by proposals
lost positive proposal assets = []
```

For decode confirmation, promote only if:

```text
lost decoded positives = []
false-positive delta <= 0
positive decoded delta >= 0
decode attempts and/or scan time improve materially
```

## Required regression fixture

`asset-0944aec7c73146f9` (`coronatest`) must remain covered in `--no-decode` mode and decoded in decode-confirmation mode. It is an easy, front-facing QR that exposed the previous hard timing-corridor rejection bug.

## Implementation notes

- Implement `--no-decode` first; decode mode can be optional or follow-up.
- Reuse existing proposal-generation and clustering plumbing.
- Prefer carrying computed grid hypotheses forward as reusable proposal metadata instead of recomputing during decode.
- Use the layered scanner artifact cache where possible:
  - L1 normalized frame
  - L2 scalar views
  - L3 binary views
  - L4 finder evidence
  - L5 proposal batches
  - L6 ranked frontier
  - L7 cluster frontier
  - L8 decode outcome when decode confirmation is enabled
- Cache artifacts should be separate per-layer/per-asset files, not monolithic JSON blobs.
- Cache invalidation is versioned per layer with numeric `version` fields. Bump the layer version when changing code that affects that layer's artifact semantics.
- `--refresh-cache` bypasses artifact reads and writes fresh artifacts; `--no-cache` disables artifact reads and writes.
- Emit per-view/per-variant timing rows for realism scoring.
- Keep cache keys separate for `--no-decode` and decode modes.
- Do not mutate production defaults from this study.

## Post-study cache restructuring

After the first `--no-decode` run is analyzed, revisit the cache boundaries before canonizing any realism signal. The likely outcome is that finder-grid realism becomes a reusable pipeline seam between ranked proposals and cluster/decode work.

Evaluate whether to keep realism artifacts as a separate layer or merge them into an adjacent layer:

```text
L6 ranked frontier
L6.5 / L7 grid-realism hypotheses
L7 / L8 cluster frontier
L8 / L9 decode outcome
```

Keep grid realism separate if multiple studies reuse the same ranked proposals with different realism formulas, if realism scoring is expensive enough to cache independently, or if realism variants are still changing. Merge it into the ranked frontier if one canonical realism score becomes part of proposal ranking and downstream always needs realism-enriched proposals. Merge it into cluster frontier if realism mostly affects representative selection.

The post-study restructuring must answer:

```text
Which stage owns grid-realism hypotheses?
Are realism scores proposal-level, representative-level, or decode-rescue-level?
Can decode consume cached geometry hypotheses directly?
Do cache keys need a new geometry-hypothesis version?
```

## Results

Exploratory component-diagnostic `--no-decode` run generated on 2026-04-27 from commit `6a62de6184cea80f1457d1dde0336d51a4351574`. This run used the earlier component-as-variant implementation; those rows are retained as diagnostic evidence, but the study implementation has since been corrected to compare `baseline` against the coherent `grid-realism-ranking` policy.

```text
tools/bench/reports/full/study/study-finder-grid-realism.json
tools/bench/reports/study/study-finder-grid-realism.summary.json
```

Run configuration:

```text
assets: 203 total, 60 positive, 143 negative
variants: baseline, projective-realism-score, module-consistency-score, grid-bounds-score, grid-timing-score, combined-grid-realism-score
implementation status: superseded by baseline vs grid-realism-ranking policy variants
noDecode: true
maxViews: 54
maxProposals: 24
maxProposalsPerView: 12
maxClusterRepresentatives: 1
```

Coverage and frontier size:

| Variant | Positive covered | Negative with proposals | Proposals | Clusters | Representatives | Lost positives |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `baseline` | 60 / 60 | 143 / 143 | 89,618 | 4,830 | 4,830 | none |
| `projective-realism-score` | 60 / 60 | 143 / 143 | 89,618 | 4,830 | 4,830 | none |
| `module-consistency-score` | 60 / 60 | 143 / 143 | 89,618 | 4,830 | 4,830 | none |
| `grid-bounds-score` | 60 / 60 | 143 / 143 | 89,618 | 4,830 | 4,830 | none |
| `grid-timing-score` | 60 / 60 | 143 / 143 | 89,618 | 4,830 | 4,830 | none |
| `combined-grid-realism-score` | 60 / 60 | 143 / 143 | 89,618 | 4,830 | 4,830 | none |

Score separation by representative:

| Variant | Positive avg | Positive p50 / p95 | Negative avg | Negative p50 / p95 | Interpretation |
| --- | ---: | --- | ---: | --- | --- |
| `projective-realism-score` | 0.81 | 0.83 / 0.83 | 0.81 | 0.83 / 0.83 | No useful separation. |
| `module-consistency-score` | 0.69 | 0.67 / 0.89 | 0.62 | 0.62 / 0.83 | Best separation in this run, but weak. |
| `grid-bounds-score` | 0.93 | 0.99 / 1.00 | 0.94 | 0.97 / 1.00 | No useful separation; many false frontiers are in-bounds. |
| `grid-timing-score` | 0.60 | 0.58 / 0.80 | 0.57 | 0.56 / 0.70 | Slight separation; current phase-insensitive sampler is too weak alone. |
| `combined-grid-realism-score` | 0.74 | 0.73 / 0.83 | 0.72 | 0.72 / 0.79 | Weak composite separation. |

Approximate all-representative AUC computed from the report rows:

| Variant | AUC |
| --- | ---: |
| `projective-realism-score` | 0.512 |
| `module-consistency-score` | 0.635 |
| `grid-bounds-score` | 0.504 |
| `grid-timing-score` | 0.545 |
| `combined-grid-realism-score` | 0.606 |

`asset-0944aec7c73146f9` / `coronatest` remained covered by all default variants in `--no-decode` mode.

Timing of scoring itself was small relative to proposal generation, but the report's artifact-cache layer accounting showed all zero hits/misses/writes for this worker-backed full run despite `--refresh-cache`. Treat artifact-cache accounting in this report as a reporting bug or aggregation gap, not evidence that no artifacts were touched.

Corrected policy-ranking `--no-decode` run generated on 2026-04-27 from commit `2f74780297b9ab6e6b24c0ba80d75780ff68c999`:

```text
tools/bench/reports/full/study/study-finder-grid-realism.json
tools/bench/reports/study/study-finder-grid-realism.summary.json
```

Run configuration:

```text
assets: 203 total, 60 positive, 143 negative
variants: baseline, grid-realism-ranking
noDecode: true
maxViews: 54
maxProposals: 24
maxProposalsPerView: 12
maxClusterRepresentatives: 1
```

Coverage and frontier size:

| Variant | Positive covered | Negative with proposals | Proposals | Clusters | Representatives | Lost positives |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `baseline` | 60 / 60 | 143 / 143 | 89,618 | 4,830 | 4,830 | none |
| `grid-realism-ranking` | 60 / 60 | 143 / 143 | 89,618 | 4,830 | 4,830 | none |

Representative-order effect:

| Variant | Assets changed | First changed rank p50 / p95 / max | Positive first changed rank p50 / p95 / max | Negative first changed rank p50 / p95 / max |
| --- | ---: | --- | --- | --- |
| `baseline` | 0 / 203 | n/a | n/a | n/a |
| `grid-realism-ranking` | 202 / 203 | 1 / 2 / 4 | 2 / 2 / 4 | 1 / 2 / 2 |

Only `asset-a63ebea2df94c77a` (`qr-neg`, 2 representatives) kept the exact baseline order. `asset-0944aec7c73146f9` / `coronatest` remained covered; its first representative stayed first and the next candidate changed at rank 2.

Policy score separation by representative:

| Variant | Positive avg | Positive p50 / p95 | Negative avg | Negative p50 / p95 | Interpretation |
| --- | ---: | --- | ---: | --- | --- |
| `baseline` proposal score | 17.72 | 17.70 / 20.05 | 17.15 | 17.31 / 19.22 | Existing ranking has mild positive/negative separation. |
| `grid-realism-ranking` | 0.74 | 0.73 / 0.83 | 0.72 | 0.72 / 0.79 | Coherent realism ranking has weak but non-zero separation. |

Grid-realism component diagnostics over all representatives:

| Component | Avg | p50 | p95 | Interpretation |
| --- | ---: | ---: | ---: | --- |
| projective | 0.81 | 0.83 | 0.83 | Saturated; weak as a discriminator. |
| module | 0.64 | 0.64 | 0.85 | Most informative component from the exploratory run. |
| bounds | 0.94 | 0.98 | 1.00 | Mostly saturated; many false frontiers are in bounds. |
| timing | 0.58 | 0.56 | 0.70 | Weak; current phase-insensitive sampler likely underpowered. |
| combined | 0.73 | 0.72 | 0.80 | Enough to reorder nearly all frontiers, not enough to justify filtering. |

Artifact-cache layer accounting still reported all zero hits/misses/writes in the corrected worker-backed full run. The cache accounting gap remains open.

Objective-search `--no-decode` run generated on 2026-04-27 from commit `fcf717b1be079778b762746fdffc5367f837339c`:

```text
tools/bench/reports/full/study/study-finder-grid-realism-objectives-nodecode.json
tools/bench/reports/study/study-finder-grid-realism-objectives-nodecode.summary.json
```

Run configuration:

```text
assets: 203 total, 60 positive, 143 negative
variants: baseline, grid-realism-ranking, realism-module-heavy, realism-decode-likelihood, realism-low-risk, realism-geomean, realism-lexicographic
noDecode: true
stageVersions: rankingPolicy=3, decodeComparison=2, visualization=1
```

Objective score separation and frontier-order effect:

| Variant | Assets changed | Positive avg | Negative avg | Delta | AUC |
| --- | ---: | ---: | ---: | ---: | ---: |
| `grid-realism-ranking` | 202 / 203 | 0.74 | 0.72 | +0.02 | 0.606 |
| `realism-module-heavy` | 201 / 203 | 0.70 | 0.66 | +0.04 | 0.632 |
| `realism-decode-likelihood` | 202 / 203 | 0.68 | 0.64 | +0.04 | 0.620 |
| `realism-low-risk` | 202 / 203 | 0.65 | 0.60 | +0.05 | 0.630 |
| `realism-geomean` | 202 / 203 | 0.68 | 0.64 | +0.04 | 0.626 |
| `realism-lexicographic` | 201 / 203 | 0.83 | 0.80 | +0.03 | 0.631 |

The no-decode objective search suggests the original composite is not the best realism objective. `realism-module-heavy`, `realism-low-risk`, and `realism-lexicographic` have better positive/negative separation than `grid-realism-ranking`, while still materially replacing the representative order.

Phase-locked semantic grid-realism runs generated on 2026-04-27 from commit `201e34ac4e4320997fbcb8b22e1dd1d83ec880eb`:

```text
tools/bench/reports/study/realism-0/full/study/study-finder-grid-realism.json
tools/bench/reports/study/realism-25/full/study/study-finder-grid-realism.json
tools/bench/reports/study/realism-200/full/study/study-finder-grid-realism.json
tools/bench/reports/study/realism-unbounded/full/study/study-finder-grid-realism.json
```

These runs use the corrected phase-locked semantic scorer (`rankingPolicy=4`) with finder-template, separator, quiet-zone, and QR-phase timing checks.

No-decode score separation:

| Variant | Positive avg | Negative avg | Delta |
| --- | ---: | ---: | ---: |
| `grid-realism-ranking` / `realism-phase-locked` | 0.65 | 0.62 | +0.03 |
| `realism-module-heavy` | 0.65 | 0.60 | +0.05 |
| `realism-decode-likelihood` | 0.64 | 0.60 | +0.04 |
| `realism-low-risk` | 0.23 | 0.14 | +0.09 |
| `realism-geomean` | 0.63 | 0.60 | +0.03 |
| `realism-lexicographic` | 0.42 | 0.37 | +0.05 |

Decode outcome by scan-level concrete-attempt budget with the phase-locked scorer:

| Budget | Variant | Positive decoded | False-positive assets | Decode attempts | Lost decoded positives | Gained decoded positives |
| ---: | --- | ---: | ---: | ---: | --- | --- |
| 25 | `baseline` | 28 / 60 | 0 | 4,436 | none | none |
| 25 | `grid-realism-ranking` / `realism-phase-locked` | 29 / 60 | 0 | 4,424 | none | `asset-532613e8ac453b24` |
| 25 | `realism-module-heavy` | 29 / 60 | 0 | 4,424 | none | `asset-532613e8ac453b24` |
| 25 | `realism-decode-likelihood` | 29 / 60 | 0 | 4,424 | none | `asset-532613e8ac453b24` |
| 25 | `realism-low-risk` | 28 / 60 | 0 | 4,448 | `asset-879ee4c825375434` | `asset-532613e8ac453b24` |
| 25 | `realism-geomean` | 29 / 60 | 0 | 4,424 | none | `asset-532613e8ac453b24` |
| 25 | `realism-lexicographic` | 29 / 60 | 0 | 4,424 | none | `asset-532613e8ac453b24` |
| 200 | `baseline` | 32 / 60 | 0 | 34,721 | none | none |
| 200 | `grid-realism-ranking` / `realism-phase-locked` | 34 / 60 | 0 | 34,515 | none | `asset-532613e8ac453b24`, `asset-c2c4e788a4932a84` |
| 200 | `realism-module-heavy` | 34 / 60 | 0 | 34,515 | none | `asset-532613e8ac453b24`, `asset-c2c4e788a4932a84` |
| 200 | `realism-decode-likelihood` | 34 / 60 | 1 | 34,339 | none | `asset-532613e8ac453b24`, `asset-c2c4e788a4932a84` |
| 200 | `realism-low-risk` | 32 / 60 | 0 | 34,655 | `asset-1b26a1d1cbb61d25`, `asset-879ee4c825375434` | `asset-532613e8ac453b24`, `asset-c2c4e788a4932a84` |
| 200 | `realism-geomean` | 34 / 60 | 0 | 34,437 | none | `asset-532613e8ac453b24`, `asset-c2c4e788a4932a84` |
| 200 | `realism-lexicographic` | 33 / 60 | 0 | 34,456 | `asset-1b26a1d1cbb61d25` | `asset-532613e8ac453b24`, `asset-c2c4e788a4932a84` |
| unbounded | `baseline` | 37 / 60 | 5 | 1,766,125 | none | none |
| unbounded | `grid-realism-ranking` / `realism-phase-locked` | 37 / 60 | 7 | 2,034,119 | none | none |
| unbounded | `realism-module-heavy` | 37 / 60 | 7 | 2,007,948 | none | none |
| unbounded | `realism-decode-likelihood` | 37 / 60 | 7 | 2,012,181 | none | none |
| unbounded | `realism-low-risk` | 37 / 60 | 7 | 2,042,123 | none | none |
| unbounded | `realism-geomean` | 37 / 60 | 7 | 2,030,977 | none | none |
| unbounded | `realism-lexicographic` | 37 / 60 | 7 | 2,008,288 | none | none |

Conclusion from phase-locked scoring: the corrected semantic scorer is useful for **bounded prioritization** but still not safe as an unbounded full-replacement ordering and still not evidence for hard filtering. With 25 attempts it gains one positive, loses none, and does not add false positives. With 200 attempts, `grid-realism-ranking` / `realism-phase-locked`, `realism-module-heavy`, and `realism-geomean` gain two positives, lose none, and do not add false positives; `realism-decode-likelihood` gains the same positives but adds one false-positive asset. Unbounded, every realism ordering preserves the same 37 positive decodes but increases false positives from 5 to 7 and adds about 242k-276k decode attempts. The next study revision must measure threshold/work-reduction curves over scored view/proposal/cluster/representative frontiers, not only final variant order.

The corrected policy run answers the no-decode frontier-order question: grid-realism objectives are coverage-safe in proposal-only mode and materially change representative order for nearly every asset. They still do **not** justify hard rejection or production canonization by no-decode evidence alone; decode confirmation must decide between objectives.

Evidence-backed decisions:

- Keep `grid-realism-ranking` as the next decode-confirmation candidate. It preserved 60 / 60 positive proposal coverage, preserved `coronatest`, and changed 202 / 203 representative frontiers.
- Treat the component checks as diagnostics only. Projective and bounds are saturated; module consistency is the most useful component; timing needs a stronger grid sampler before it can carry much weight.
- Do not promote hard rejection. The full policy score only separates positives and negatives weakly (`0.74` vs `0.72` average), so thresholding would be unjustified.
- Use L8 decode confirmation next to compare actual scanner outcomes: lost decoded positives, false positives, decode attempts, processed representatives, first-success rank, and `coronatest` decoded status.

Answered:

- Cheap grid-realism scoring can run before decode.
- The coherent grid-realism policy preserves proposal coverage in `--no-decode` mode.
- The coherent policy materially changes representative ordering.

Decode-confirmation runs with capped concrete decode attempts generated on 2026-04-27 from commit `fa07372ac6e831f089c2705fe470e452e38458ca`:

```text
tools/bench/reports/full/study/study-finder-grid-realism.json
tools/bench/reports/study/study-finder-grid-realism.summary.json
tools/bench/reports/full/study/study-finder-grid-realism-50.json
tools/bench/reports/study/study-finder-grid-realism-50.summary.json
```

Shared run configuration:

```text
assets: 203 total, 60 positive, 143 negative
variants: baseline, grid-realism-ranking
stageVersions: rankingPolicy=2, decodeComparison=2, visualization=1
```

Decode outcome by scan-level concrete-attempt budget:

| Budget | Variant | Positive decoded | False-positive assets | Decode attempts | Lost decoded positives | Gained decoded positives |
| ---: | --- | ---: | ---: | ---: | --- | --- |
| 25 | `baseline` | 28 / 60 | 0 | 4,436 | none | none |
| 25 | `grid-realism-ranking` | 29 / 60 | 0 | 4,424 | none | `asset-532613e8ac453b24` |
| 25 | `realism-module-heavy` | 29 / 60 | 0 | 4,424 | none | `asset-532613e8ac453b24` |
| 25 | `realism-decode-likelihood` | 29 / 60 | 0 | 4,424 | none | `asset-532613e8ac453b24` |
| 25 | `realism-low-risk` | 29 / 60 | 0 | 4,424 | none | `asset-532613e8ac453b24` |
| 25 | `realism-geomean` | 29 / 60 | 0 | 4,424 | none | `asset-532613e8ac453b24` |
| 25 | `realism-lexicographic` | 29 / 60 | 0 | 4,424 | none | `asset-532613e8ac453b24` |
| 50 | `baseline` | 29 / 60 | 0 | 8,798 | none | none |
| 50 | `grid-realism-ranking` | 30 / 60 | 0 | 8,761 | none | `asset-532613e8ac453b24` |
| 200 | `baseline` | 32 / 60 | 0 | 34,721 | none | none |
| 200 | `grid-realism-ranking` | 32 / 60 | 0 | 34,553 | `asset-1b26a1d1cbb61d25` | `asset-532613e8ac453b24` |
| 200 | `realism-module-heavy` | 33 / 60 | 0 | 34,534 | none | `asset-532613e8ac453b24` |
| 200 | `realism-decode-likelihood` | 32 / 60 | 0 | 34,553 | `asset-1b26a1d1cbb61d25` | `asset-532613e8ac453b24` |
| 200 | `realism-low-risk` | 32 / 60 | 0 | 34,553 | `asset-1b26a1d1cbb61d25` | `asset-532613e8ac453b24` |
| 200 | `realism-geomean` | 32 / 60 | 0 | 34,553 | `asset-1b26a1d1cbb61d25` | `asset-532613e8ac453b24` |
| 200 | `realism-lexicographic` | 33 / 60 | 0 | 34,534 | none | `asset-532613e8ac453b24` |
| unbounded | `baseline` | 37 / 60 | 5 | 1,766,125 | none | none |
| unbounded | `grid-realism-ranking` | 37 / 60 | 8 | 2,034,320 | none | none |
| unbounded | `realism-module-heavy` | 37 / 60 | 8 | 2,002,155 | none | none |
| unbounded | `realism-decode-likelihood` | 37 / 60 | 7 | 2,015,662 | none | none |
| unbounded | `realism-low-risk` | 37 / 60 | 9 | 1,992,344 | none | none |
| unbounded | `realism-geomean` | 37 / 60 | 7 | 2,016,539 | none | none |
| unbounded | `realism-lexicographic` | 37 / 60 | 9 | 1,978,102 | none | none |

At capped budgets, successful decodes were at representative rank 1 for all variants. `asset-0944aec7c73146f9` / `coronatest` decoded in all variants.

Stable gained asset:

```text
asset-532613e8ac453b24
expected/decoded text: https://qr.thaichana.com/?appId=0001&shopId=S0000002150
baseline @ 50 attempts: no decode
baseline @ 25 attempts: no decode
grid-realism-ranking: success at representative rank 1, 13 attempts
```

Cache behavior for the capped runs:

```text
study cache: first run per budget has 0 hits because maxDecodeAttempts is part of the numeric-versioned config key
artifact cache: L1/L2/L3/L5/L6/L7 hits; no recomputation of scanner frontier layers
```

Updated evidence-backed decisions:

- Do not canonize `grid-realism-ranking` as a replacement ordering. It improves early budgets (25 and 50 attempts) but at 200 attempts it swaps one gain for one loss: it still gains `asset-532613e8ac453b24`, but loses `asset-1b26a1d1cbb61d25`, which baseline decodes in 181 attempts.
- At the 25-attempt objective-search run, all tested realism objectives tie: each gains `asset-532613e8ac453b24`, loses no positives, has zero false positives, and uses 4,424 attempts. Early-budget decode does not distinguish the objective formulas.
- At the 200-attempt objective-search run, `realism-module-heavy` and `realism-lexicographic` are the best full-replacement objectives: both decode 33 positives, gain `asset-532613e8ac453b24`, lose no baseline positives, introduce no false positives, and use 34,534 attempts (`-187` vs baseline). They preserve `asset-1b26a1d1cbb61d25` because the baseline-winning representative remains first under those objectives, while the original composite/decode-likelihood/low-risk/geomean move it behind failing representatives.
- The unbounded run reverses the production decision: all objectives tie baseline at 37 positives, but every realism objective increases false positives and total attempts. Do not canonize any unbounded full-replacement realism ordering from the current objective set.
- Treat the capped-budget wins as evidence for early-budget prioritization only. Any production change needs either a false-positive guard, a bounded decode policy, or a multi-QR cluster-local budget that prevents unbounded traversal from surfacing extra negative decodes.
- Keep hard rejection binned. The evidence supports prioritization only.
- For multi-QR policy, add/compare cluster-local representative budgets separately from this scan-level capped decode test.

Answered:

- Cheap grid-realism scoring can run before decode.
- The coherent grid-realism policy preserves proposal coverage in `--no-decode` mode.
- The coherent policy materially changes representative ordering.
- Under 25- and 50-attempt scan-level budgets, grid-realism ranking improves decoded positives by one with no observed downside.
- Under a 200-attempt budget, the original full-replacement ordering is not recall-safe, but the module-heavy and lexicographic objectives are recall-safe and improve positives by one.
- Under unbounded decode, no realism objective improves positives and all increase false positives, so the current objective set is not safe as an unbounded production replacement.

Partially answered:

- Whether the ranking improves real decode work across budgets: partially; positive at early budgets, not recall-safe as a full replacement at 200 attempts.
- Whether timing-grid evidence is useful: weak in the current sampler and needs improvement.
- Whether cache layer summaries are reliable under worker full runs: improved after worker summary aggregation; these runs showed artifact-cache hits for upstream layers.
