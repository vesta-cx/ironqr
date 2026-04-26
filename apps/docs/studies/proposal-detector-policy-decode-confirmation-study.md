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

Pending.

## Conclusion / evidence-backed decision

Pending generated study evidence.
