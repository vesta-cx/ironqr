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
maxDecodeAttempts=unbounded by default
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

Full confirmation run generated `2026-04-26T03:30:32.682Z` from commit `c31af6d86ba509844a549a281c45f3eb189996af` with dirty working tree state. Reports:

```text
tools/bench/reports/full/study/study-proposal-geometry-decode-confirmation.json
tools/bench/reports/study/study-proposal-geometry-decode-confirmation.summary.json
```

Run shape:

```text
variants=baseline,aspect-reject-conservative,timing-corridor-reject-conservative,aspect-timing-penalty
assets=203 positives=60 negatives=143
maxProposals=24 maxClusterRepresentatives=1 maxDecodeAttempts=200 maxViews=54
cache hits=0 misses=406 writes=203
```

This historical run used the old bounded default. Current study defaults remove `maxDecodeAttempts`; pass `--max-decode-attempts N` only for explicitly bounded debugging.

| Variant | Positive decoded assets | False-positive assets | Proposals | Clusters | Processed reps | Decode attempts | Scan ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `baseline` | 24 | 0 | 67,967 | 4,502 | 236 | 36,541 | 398,709.65 |
| `aspect-reject-conservative` | 24 | 0 | 65,965 | 4,493 | 236 | 36,541 | 385,155.15 |
| `timing-corridor-reject-conservative` | 25 | 0 | 58,323 | 4,416 | 225 | 36,371 | 391,416.49 |
| `aspect-timing-penalty` | 24 | 0 | 67,952 | 4,502 | 236 | 36,541 | 373,442.65 |

Compared with `baseline`:

```text
aspect-reject-conservative:
  positive delta = 0
  false-positive delta = 0
  proposal delta = -2,002
  decode attempt delta = 0
  lost/gained positives = 0/0

timing-corridor-reject-conservative:
  positive delta = +1
  false-positive delta = 0
  proposal delta = -9,644
  decode attempt delta = -170
  lost/gained positives = 1/2

aspect-timing-penalty:
  positive delta = 0
  false-positive delta = 0
  proposal delta = -15
  decode attempt delta = 0
  lost/gained positives = 0/0
```

Timing-corridor rejection changed positive decode membership:

```text
Lost:   asset-0944aec7c73146f9  expected="coronatest"
Gained: asset-382c3e31e04b3fc9  expected="https://viarami.com"
Gained: asset-e94cb1a1e0173763  expected="http://www.sanisale.com/"
```

The lost positive remains important: `baseline` decoded `asset-0944aec7c73146f9` in 1 attempt from 12 proposals, while timing-corridor rejection failed after 200 attempts. The gains were both baseline budget misses that timing-corridor rejection decoded with much smaller frontiers.

## Conclusion / evidence-backed decision

`aspect-reject-conservative` is the safe geometry filter candidate from this decode run: it preserved decoded positives, false-positive behavior, and decode attempt count while removing `2,002` proposals. It does not improve decode effort yet, but it is decode-equivalent under the current bounded settings.

Do not canonize `timing-corridor-reject-conservative` as-is. It has the largest frontier/decode-work reduction and a net +1 decoded positive, but it loses one baseline positive. Treat it as a tuning candidate.

Bin `aspect-timing-penalty` for now: it is decode-equivalent, but only removes `15` proposals and does not reduce attempts.

Next step: either canonize/confirm `aspect-reject-conservative` as a safe small frontier reduction, or tune timing-corridor rejection around `asset-0944aec7c73146f9` to preserve the baseline decode while keeping the two gains.
