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

The study compares policy behavior with and without that coherent realism pipeline. Component scores are diagnostics nested under each policy row, not default variants.

| Variant | Purpose |
| --- | --- |
| `baseline` | Existing proposal/ranking/cluster representative order with no added grid-realism ordering. |
| `grid-realism-ranking` | Reorder representatives by the full dependent grid-realism score, with proposal score as a tie-breaker. |
| `grid-realism-ranking-no-timing` | Optional ablation to quantify timing's contribution to the full ranking policy. Not enabled by default. |
| `grid-realism-ranking-no-module` | Optional ablation to quantify module-consistency's contribution to the full ranking policy. Not enabled by default. |

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
| Grid timing diagnostic distribution | score | Semantic timing evidence inside the full policy. |
| Combined ranking score distribution by label | score | Positive/negative separation of the full policy. |
| Per-policy runtime | ms | Whether the full policy is cheap enough before decode. |

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

## Conclusion / evidence-backed decision

The run answers the proposal-coverage guard: the default scoring-only variants did not lose any positive proposal assets, and `coronatest` remained covered. It does **not** justify hard rejection or canonization.

Evidence-backed decisions:

- Do not promote `projective-realism-score` or `grid-bounds-score` as standalone ranking signals; their positive/negative score distributions are effectively indistinguishable.
- Keep `module-consistency-score` as the most promising component signal, but only as ranking evidence. Its separation is real but modest (`avg +0.07`, AUC ≈ 0.635), so it needs decode-confirmation and likely a better frontier-delta metric before canonization.
- Keep `grid-timing-score` as a research direction, but improve the sampler before relying on it. The current phase-insensitive row/column 6 score has weak separation (`avg +0.03`, AUC ≈ 0.545).
- Do not run or promote hard `combined-grid-realism-reject-very-conservative` yet. The scoring components are not strong enough to set safe thresholds from this run.
- Next implementation should evaluate ranking/frontier impact, not just raw score distributions: reorder representatives by `module-consistency-score`, `grid-timing-score`, and a revised combined score, then compare lost positives, decode attempts, processed representatives, and frontier changes with L8 decode confirmation.

Partially answered:

- Whether cheap realism signals can be computed before decode: yes.
- Whether first-pass scores separate positives from negatives strongly enough: no; only module consistency is moderately promising.
- Whether hard filtering is safe: unanswered, and current evidence argues against trying it yet.
- Whether cache layer summaries are reliable under worker full runs: no; the report exposed an accounting gap.
