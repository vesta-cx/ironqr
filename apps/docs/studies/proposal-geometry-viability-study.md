# Proposal Geometry Viability Study

## Problem / question

Finder triples are currently filtered by coarse triangle geometry. Highly stylized, perspective-warped, or distorted QR codes make location-only geometry noisy, but finder evidence also carries horizontal and vertical module-size estimates. This study asks whether aspect/scale consistency can improve proposal realism without losing positive proposal coverage.

The production change under study is semantic finder-triple scoring/filtering during proposal assembly, not detector selection, early exits, or proposal budgets.

## Hypothesis / thesis

Finder triples whose aligned finders have contradictory local aspect ratios or scale estimates are often low-signal combinations. Soft penalties may push them below realistic triples, and conservative hard rejection may remove nonsense triples without losing useful proposal coverage.

Null hypothesis: current baseline geometry remains necessary because aspect/scale variants either lose positive proposal coverage or only reshuffle the frontier without useful reduction.

## Designed experiment / study

Run:

```bash
bun run --cwd tools/bench bench study proposal-geometry-viability --detector-policy no-flood
```

The study uses canonical proposal assembly (`no-allocation-score`) and the `no-flood` detector policy. Every variant scores the normal finder evidence and uses the normal proposal caps. It does not introduce early exits, evidence budgets, view skipping, or fallback gating.

Variants:

| Variant | Behavior | Question answered |
| --- | --- | --- |
| `baseline` | Current canonical geometry score/filter. | Control. |
| `aspect-penalty` | Penalize aligned finder pairs whose `log(hModuleSize / vModuleSize)` signs/magnitudes disagree. | Does aspect consistency improve frontier realism without hard rejection? |
| `aspect-reject-conservative` | Hard-reject only extreme opposite aspect contradictions. | Can obvious aspect contradictions be filtered safely? |
| `scale-consistency-penalty` | Penalize aligned finder pairs with inconsistent module/h/v scale estimates. | Does local scale consistency provide useful ranking signal? |
| `aspect-scale-penalty` | Combined aspect and scale penalty. | Do the two realism signals compose? |
| `timing-corridor-penalty` | Penalize triples whose inferred timing corridors do not show alternating structure. | Does direct binary-pixel timing evidence improve frontier realism? |
| `timing-corridor-reject-conservative` | Hard-reject only strongly unsupported timing corridors. | Can timing corridors safely justify proposal rejection? |
| `aspect-timing-penalty` | Combined aspect and timing-corridor penalty. | Do local aspect and direct timing evidence compose? |

Default corpus: all approved assets, all default binary views.

## Metrics table

| Metric | Unit | Decision use |
| --- | --- | --- |
| Positive proposal asset coverage | assets | Mandatory recall guard. |
| Negative proposal asset coverage | assets | Safety/frontier-shape guard. |
| Proposal count delta | proposals | Measures frontier shrink/expansion. |
| Triple count delta | triples | Measures semantic filtering effect. |
| Proposal signature mismatch assets | assets | Expected for semantic variants, but scopes frontier change. |
| Proposal count mismatch assets | assets | Coarse frontier divergence. |
| Lost/gained positive asset ids | asset ids | Explains recall changes. |
| `tripleAssemblyMs` | ms | Assembly cost impact. |
| `proposalConstructionMs` | ms | Proposal object construction impact. |
| Detector timings | ms | Confirm detector work is unchanged across variants. |

## Decision rule

Advance a soft-scoring variant only if:

```text
positive proposal asset delta = 0
lost positive asset ids = []
negative proposal behavior is not worse
proposal frontier change is explainable
```

Advance a hard-reject variant only if:

```text
positive proposal asset delta = 0
lost positive asset ids = []
triple/proposal reduction is meaningful
follow-up decode confirmation accepts the reduced frontier
```

Do not canonize semantic filtering from proposal-only evidence if proposal signatures change. Timing-corridor hard rejection can be treated as stronger proposal-level justification than aspect-only rejection, but still needs decode confirmation before production use.

## Results

Full timing-corridor geometry run generated `2026-04-25T23:30:29.584Z` from commit `0eaf53a296eb7017544f7faf8d4ac3583f342309` with dirty working tree state. Reports:

```text
tools/bench/reports/full/study/study-proposal-geometry-viability.json
tools/bench/reports/study/study-proposal-geometry-viability.summary.json
```

Run shape:

```text
assets=203 positives=60 negatives=143
detectorPolicyId=no-flood maxViews=54 maxProposals=24
cache hits=0 misses=406 writes=203
```

| Variant | Pos assets with proposals | Neg assets with proposals | Proposals | Triples | Signature-mismatch assets | Count-mismatch assets | Triple assembly ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `baseline` | 60 | 143 | 168,366 | 540,894 | 0 | 0 | 554.07 |
| `aspect-penalty` | 60 | 143 | 168,366 | 540,894 | 144 | 0 | 1,018.63 |
| `aspect-reject-conservative` | 60 | 143 | 160,996 | 497,005 | 186 | 149 | 1,054.05 |
| `scale-consistency-penalty` | 60 | 143 | 168,366 | 540,894 | 127 | 0 | 1,026.08 |
| `aspect-scale-penalty` | 60 | 143 | 168,366 | 540,894 | 158 | 0 | 975.85 |
| `timing-corridor-penalty` | 60 | 143 | 168,366 | 540,894 | 140 | 0 | 999.74 |
| `timing-corridor-reject-conservative` | 60 | 141 | 136,220 | 367,323 | 203 | 181 | 948.88 |
| `aspect-timing-penalty` | 60 | 143 | 168,366 | 540,894 | 166 | 0 | 1,017.52 |

All variants preserved positive proposal-asset coverage (`60/60`). Soft penalties changed proposal signatures without reducing proposal counts. `aspect-reject-conservative` reduced the frontier by `7,370` proposals (`4.38%`) and `43,889` triples (`8.11%`). `timing-corridor-reject-conservative` reduced the frontier much more aggressively: `32,146` proposals (`19.09%`) and `173,571` triples (`32.09%`) while preserving positive proposal-asset coverage and removing all proposals from two negative assets.

The two negative assets removed entirely by timing-corridor rejection were:

```text
asset-3a7ee8a00c65d65e: 12 -> 0 proposals, 12 -> 0 triples
asset-a63ebea2df94c77a: 4 -> 0 proposals, 4 -> 0 triples
```

Largest `timing-corridor-reject-conservative` proposal reductions included:

```text
asset-c66cb59e2729aa1e -NEG: -640 proposals, -1,679 triples
asset-1184fc75626fdbe9 +QR:  -580 proposals, -1,128 triples
asset-e29543dbddb7e837 -NEG: -580 proposals, -777 triples
asset-6333b4abcbc3d63f -NEG: -552 proposals, -920 triples
asset-3d40d63fdf14e61b -NEG: -531 proposals, -873 triples
```

## Interpretation plan

First compare asset-level proposal coverage against `baseline`. No variant lost a positive asset, so all remain viable for decode-confirmation follow-up. Soft penalties are frontier-ordering candidates: they changed signatures but not counts. The hard-reject variants are the actual frontier reducers. Timing-corridor rejection is the strongest proposal-level rejection evidence because it samples alternating structure between aligned finders, and it removes about one-third of triples while retaining positive proposal presence.

The timing data should not drive promotion: semantic penalties add triple-scoring work (`+394ms` to `+500ms` triple assembly), while scan-time decreases are dominated by detector/view timing variance from rerunning each variant. The value of these variants is frontier realism and later decode-cost reduction, not proposal assembly speed.

## Conclusion / evidence-backed decision

Advance `timing-corridor-reject-conservative` to decode confirmation as the lead realism filter: it preserved positive proposal coverage and removed `173,571` triples / `32,146` proposals. Do not canonize it from proposal-only data because it changes proposal signatures and removes proposals.

Keep `aspect-reject-conservative` as the gentler hard-reject fallback. Keep `aspect-timing-penalty` as the soft-scoring backup if decode confirmation shows hard rejection is too aggressive. Bin standalone `aspect-penalty`, `scale-consistency-penalty`, and `timing-corridor-penalty` unless later decode evidence specifically needs them.
