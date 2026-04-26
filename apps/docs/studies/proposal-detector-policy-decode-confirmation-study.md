# Proposal Detector Policy Decode Confirmation Study

## Problem / question

Proposal-only detector policy evidence showed `no-flood` matched `full-current` proposal behavior while removing flood cost. This study asks whether removing flood preserves actual decode outcomes when the scanner runs clustering and decode.

## Hypothesis / thesis

Flood finder evidence is redundant for the current corpus once row-scan and matcher evidence are available. The null hypothesis is that flood contributes at least one decoded positive, prevents a false positive, or reduces downstream decode work enough to keep it.

## Designed experiment / study

Run:

```bash
bun run bench study proposal-detector-policy-decode-confirmation --refresh-cache
```

Default policies:

| Policy | Purpose |
| --- | --- |
| `full-current` | Current detector stack control: row-scan, flood, matcher, dedupe. |
| `no-flood` | Candidate detector stack: row-scan, matcher, dedupe. |

Defaults:

```text
rankingVariant=timing-heavy
geometryVariant=baseline
maxProposals=24
maxClusterRepresentatives=1
maxDecodeAttempts=unbounded by default
maxViews=54
allowMultiple=false
continueAfterDecode=false
```

Pass `--max-decode-attempts N` only when explicitly studying bounded production budgets.

## Metrics table

| Metric | Unit | Decision use |
| --- | --- | --- |
| Positive decoded assets | assets | Primary recall guard. |
| False-positive assets | assets | Safety guard. |
| Lost/gained positive asset ids | asset ids | Explain detector-policy regressions/improvements. |
| Proposal count | proposals | Frontier size. |
| Cluster count / processed representatives | count | Decode frontier work. |
| Decode attempts / successes | count | Decode effort and outcome. |
| Proposal, ranking, clustering, structure, module-sampling, decode timings | ms | Cost attribution. |

## Decision rule

Promote `no-flood` only if, relative to `full-current`:

```text
lost positive asset ids = []
false-positive asset delta <= 0
positive decoded asset delta >= 0
decode attempts and/or scan time improve materially
```

If a run is bounded by `--max-decode-attempts`, treat gains/losses as production-budget evidence rather than exhaustive decode capability.

## Results

Full unbounded decode run generated `2026-04-26T12:12:26.936Z` from commit `07d6a72e3403794c161fe4e7875a1270d0f6f28a` with dirty working tree state. Reports:

```text
tools/bench/reports/full/study/study-proposal-detector-policy-decode-confirmation.json
tools/bench/reports/study/study-proposal-detector-policy-decode-confirmation.summary.json
```

Run shape:

```text
policies=full-current,no-flood
assets=203 positives=60 negatives=143
maxProposals=24 maxClusterRepresentatives=1 maxDecodeAttempts=unbounded maxViews=54
cache hits=0 misses=406 writes=203
```

| Policy | Positive decoded assets | False-positive assets | Proposals | Clusters | Processed reps | Decode attempts | Proposal ms | Scan ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `full-current` | 36 | 0 | 64,690 | 4,471 | 4,288 | 1,859,568 | 439,531.23 | 6,758,762.28 |
| `no-flood` | 36 | 0 | 64,690 | 4,471 | 4,288 | 1,859,568 | 243,738.46 | 6,420,923.35 |

Compared with `full-current`, `no-flood`:

```text
positive decoded asset delta = 0
false-positive asset delta = 0
proposal delta = 0
cluster delta = 0
processed representative delta = 0
decode attempt delta = 0
scan delta = -337,838.93ms
proposal-view delta = -195,792.77ms
lost/gained positives = 0/0
```

This confirms the proposal-only result at decode level: flood contributes no retained proposals, clusters, decode attempts, decoded positives, or false-positive suppression on this corpus under the current `timing-heavy` ranking policy.

## Conclusion / evidence-backed decision

Canonize `no-flood` as the default proposal detector policy. It satisfies the decision rule with exact decode-frontier equivalence and materially lower scan time.

Rejected alternative: keep `full-current`. The decode run found no capability or downstream-work benefit from flood, while it increased proposal-stage and total scan cost.

Known limitation: this decision is corpus-backed, not a proof that flood is useless forever. Rerun this study after major detector changes, corpus expansion, or if a new asset class relies on flood-only finder evidence.
