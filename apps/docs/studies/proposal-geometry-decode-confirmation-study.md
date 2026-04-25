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

Pending.

## Conclusion / evidence-backed decision

Pending generated study evidence.
