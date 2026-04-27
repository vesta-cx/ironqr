# Finder / Decode View Correlation Study

## Problem / question

Finder detection and decode may prefer different binary views. Finder detection wants views that make finder patterns easy to locate; decode wants views that make the full module grid sample cleanly after geometry is known. This study asks whether the highest-confidence finder/proposal view is also the highest-confidence decode view, or whether cluster representative ordering needs a separate decode-oriented view priority list.

## Hypothesis / thesis

The preferences can realistically diverge. Finder detection is dominated by coarse finder contrast, component/run geometry, and detector scoring. Decode success is dominated by per-module threshold quality, timing/alignment sampling, local blur/noise, polarity, and the decode cascade's sampling behavior. The null hypothesis is that view rankings are strongly correlated, so one canonical finder/proposal view priority can also drive cluster representative priority.

## Designed experiment / study

Run a study that uses every default binary view for proposal generation and every default binary view for decode probing.

Proposed command:

```bash
bun run bench study finder-decode-view-correlation --refresh-cache
```

Study setup:

```text
detectorPolicy=no-flood
rankingVariant=timing-heavy
geometryVariant=baseline
clusterRepresentativeVariant=proposal-score
proposalViewIds=listDefaultBinaryViewIds()
decodeViewIds=listDefaultBinaryViewIds()
maxProposals=24
maxClusterRepresentatives=1 or 3
maxDecodeAttempts=unbounded by default
allowMultiple=false
continueAfterDecode=false
```

Implementation note: current decode uses `viewBank.getDecodeNeighborhood(proposal.binaryViewId)` and limits that neighborhood. This study needs study-only plumbing to override the decode neighborhood with all default binary views, or an exhaustive post-frontier probe that takes each processed representative geometry and tries all decode views without changing production decode policy.

For each asset and variant, collect:

| Measurement | Source | Purpose |
| --- | --- | --- |
| Per-view finder counts | `proposal-view-generated` | Finder evidence strength by view. |
| Per-view proposal counts | `proposal-view-generated` | Proposal yield by view. |
| Per-view max / average proposal score | `proposal-ranked` grouped by proposal source view | Finder/proposal confidence rank. |
| Winning proposal source view | `cluster-finished.winningProposalId` joined to `proposal-ranked` | Which finder/proposal view produced the decoded candidate. |
| Winning geometry source view | `geometry-candidate-created` joined to success attempt | Which view anchored geometry. |
| Winning decode view | `decode-attempt-succeeded.decodeBinaryViewId` | Which binary view actually decoded. |
| First-success attempt rank per decode view | decode attempts | Decode capability rank. |
| Decode successes/failures by decode view | decode attempts | View-level decode reliability. |

Compute, per positive asset and in aggregate:

```text
top finder/proposal view == winning proposal source view
top finder/proposal view == winning decode view
winning proposal source view == winning decode view
Spearman/Kendall rank correlation between per-view finder score rank and decode success/attempt rank
per-view decode contribution counts
per-view finder-only-high / decode-low disagreements
per-view finder-low / decode-high disagreements
```

## Metrics table

| Metric | Unit | Decision use |
| --- | --- | --- |
| Exact top-view agreement | fraction of decoded positives | Direct evidence for one vs two priority lists. |
| Rank correlation | Spearman/Kendall | Measures whether finder confidence predicts decode capability. |
| Unique decode-winning views | view ids/counts | Candidate decode-priority list. |
| Unique finder-winning views | view ids/counts | Candidate finder/proposal-priority list. |
| Decode successes by view | count | Decode-priority ordering. |
| Finder/proposal yield by view | count/score | Finder-priority ordering. |
| Disagreement assets | asset ids | Inspect causes and regression fixtures. |

## Decision rule

Use one shared canonical priority list only if:

```text
top finder/proposal view matches winning decode view on most decoded positives
rank correlation is strong
no material cluster-representative wins come from finder-low/decode-high views
```

Create two canonical priority lists if:

```text
top-view agreement is weak or moderate
rank correlation is weak
one or more views are consistently decode-high but finder-low
cluster representative study shows decode-oriented view ordering reduces attempts or gains positives
```

If two lists are justified:

```text
finder/proposal view priority: optimize evidence discovery and proposal yield
decode representative view priority: optimize first successful decode attempts inside clusters
```

## Results

Pending.

## Conclusion / evidence-backed decision

Pending generated study evidence.
