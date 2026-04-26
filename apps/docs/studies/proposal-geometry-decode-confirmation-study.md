# Proposal Geometry Decode Confirmation Study

## Problem / question

Proposal-only geometry evidence showed timing-corridor hard rejection removes many triples/proposals while preserving positive proposal coverage. This study asks whether those semantic proposal filters preserve actual decode outcomes and reduce downstream proposal/decode work.

## Hypothesis / thesis

Timing-corridor rejection removes unrealistic finder triples and should reduce proposal/decode work without losing decoded positives. The null hypothesis is that removed proposals are needed for robust decode, so baseline geometry should remain canonical.

## Designed experiment / study

Run:

```bash
bun run --cwd tools/bench bench study proposal-geometry-decode-confirmation
```

Default variants:

| Variant | Purpose |
| --- | --- |
| `baseline` | Current canonical geometry control. |
| `aspect-reject-conservative` | Gentler hard-reject proposal filter. |
| `timing-corridor-reject-conservative` | Lead proposal-only realism filter candidate. |
| `aspect-timing-penalty` | Soft-scoring backup combining aspect and timing evidence. |

Defaults:

```text
detectorPolicy=no-flood
maxProposals=24
maxClusterRepresentatives=1
maxDecodeAttempts=200
maxViews=54
allowMultiple=false
continueAfterDecode=false
```

## Metrics table

| Metric | Unit | Decision use |
| --- | --- | --- |
| Positive decoded assets | assets | Primary recall guard. |
| False-positive assets | assets | Safety guard. |
| Lost/gained positive asset ids | asset ids | Explain regressions. |
| Proposal count | proposals | Frontier reduction. |
| Cluster count / processed representatives | count | Decode frontier work. |
| Decode attempts / successes | count | Decode effort and outcome. |
| Proposal, structure, geometry, module-sampling, decode timings | ms | Cost attribution. |

## Decision rule

Advance a geometry filter only if, relative to `baseline`:

```text
positive decoded asset delta = 0
false-positive asset delta <= 0
lost positive asset ids = []
decode attempts and/or proposal count improve materially
```

Do not canonize from this run alone if timing remains noisy; use it to select a final narrow confirmation if needed.

## Results

Narrow timing-corridor decode run generated `2026-04-26T03:25:44.842Z` from commit `0f891c860ce7d811cef6663e2d82669fda2de031` with dirty working tree state. Reports:

```text
tools/bench/reports/full/study/study-proposal-geometry-decode-confirmation.json
tools/bench/reports/study/study-proposal-geometry-decode-confirmation.summary.json
```

Run shape:

```text
variants=baseline,timing-corridor-reject-conservative
assets=203 positives=60 negatives=143
maxProposals=24 maxClusterRepresentatives=1 maxDecodeAttempts=200 maxViews=54
cache hits=203 misses=0 writes=0
```

| Variant | Positive decoded assets | False-positive assets | Proposals | Clusters | Processed reps | Decode attempts | Scan ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `baseline` | 24 | 0 | 67,967 | 4,502 | 236 | 36,541 | 437,833.94 |
| `timing-corridor-reject-conservative` | 25 | 0 | 58,323 | 4,416 | 225 | 36,371 | 426,702.97 |

Compared with `baseline`, timing-corridor rejection:

```text
positive decoded asset delta = +1
false-positive asset delta = 0
proposal delta = -9,644
cluster delta = -86
processed representative delta = -11
decode attempt delta = -170
scan delta = -11,130.97ms
```

Asset-level decode changes:

```text
Lost:   asset-0944aec7c73146f9  expected="coronatest"
Gained: asset-382c3e31e04b3fc9  expected="https://viarami.com"
Gained: asset-e94cb1a1e0173763  expected="http://www.sanisale.com/"
```

The lost positive is important: `baseline` decoded `asset-0944aec7c73146f9` in 1 attempt from 12 proposals, while timing-corridor rejection failed after 200 attempts despite producing 177 proposals. The two gains were both baseline budget misses that timing-corridor rejection decoded with much smaller frontiers.

## Conclusion / evidence-backed decision

Do not canonize `timing-corridor-reject-conservative` as-is. It improved net decoded positives and reduced proposal/decode work, but it lost one baseline positive. The filter is promising as a decode-confirmation candidate, not production-ready.

Next step: inspect or tune the lost asset (`asset-0944aec7c73146f9`) and run a narrower follow-up that preserves that decode while keeping the two gains and most of the frontier reduction.
