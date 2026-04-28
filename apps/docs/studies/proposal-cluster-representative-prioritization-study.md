# Proposal Cluster Representative Prioritization Study

## Problem / question

After proposal ranking and no-flood canonization, most remaining scanner time is spent trying clustered proposal representatives through structure, sampling, and decode. This study asks whether choosing better representatives inside each near-duplicate proposal cluster reduces decode work or improves decode outcomes without deleting candidates or changing QR decode internals.

## Hypothesis / thesis

The highest global proposal score is not always the best representative inside a cluster. Prioritizing representatives by timing, quiet-zone, alignment, or view diversity may try a decodable representative earlier while preserving the same cluster frontier. The null hypothesis is that current proposal-score ordering is already optimal, or that alternative ordering loses positives / increases false positives.

Design note: finder detection confidence and decode capability may prefer different binary views. Proposal generation should keep a finder-oriented view priority for finding evidence, but cluster representative ordering may need a separate decode-oriented view priority based on which views actually decode best after proposals are clustered. Treat this as two possible canonical priority lists, not one shared list by default.

## Designed experiment / study

Run:

```bash
bun run bench study proposal-cluster-representative-prioritization --refresh-cache
```

Default variants:

| Variant | Purpose |
| --- | --- |
| `proposal-score` | Current representative ordering control. |
| `timing-score` | Prefer representatives with strongest grid timing-line support. |
| `quiet-timing-score` | Prefer quiet-zone + timing + alignment evidence. |
| `decode-signal-score` | Strongest decode-likelihood representative score. |
| `view-diverse-score` | Prefer view-family diversity before proposal score when multiple reps are allowed. |
| `decode-view-priority` | Future candidate: prefer representatives from binary views with best empirical decode success, not finder-detection yield. |

Defaults:

```text
detectorPolicy=no-flood
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
| Lost/gained positive asset ids | asset ids | Explain representative-order regressions/improvements. |
| Cluster count / processed representatives | count | Frontier work after representative ordering. |
| Decode attempts / successes | count | Decode effort and outcome. |
| Structure, geometry, module-sampling, decode timings | ms | Cost attribution. |

## Decision rule

Advance a representative ordering variant only if, relative to `proposal-score`:

```text
lost positive asset ids = []
false-positive asset delta <= 0
positive decoded asset delta >= 0
processed representatives and/or decode attempts improve materially
```

If using `maxClusterRepresentatives=1`, this tests which single cluster representative should be tried. If using a higher representative budget, also inspect whether `view-diverse-score` reduces attempts by avoiding near-duplicate representatives.

Before canonizing representative ordering, inspect per-view decode contribution among successful representatives. If decode-winning views differ from finder-productive views, add and run a `decode-view-priority` variant rather than reusing finder/proposal view order.

## Results

Full unbounded run generated `2026-04-27T12:14:49.154Z` from commit `7d583f0936f64a4cff6abc5cc78bf5458d25cc12` with dirty working tree state. Reports:

```text
tools/bench/reports/full/study/study-proposal-cluster-representative-prioritization.json
tools/bench/reports/study/study-proposal-cluster-representative-prioritization.summary.json
```

Run shape:

```text
variants=proposal-score,timing-score,quiet-timing-score,decode-signal-score,view-diverse-score
assets=203 positives=60 negatives=143
maxProposals=24 maxClusterRepresentatives=1 maxDecodeAttempts=unbounded maxViews=54
cache hits=0 misses=406 writes=203
```

Decode was used as an accuracy guard and work proxy, not as the thing under test. Do not choose a representative variant from full end-to-end decode timing alone; compare representative-order effects: lost positives, false positives, processed representatives, and decode-attempt deltas.

| Variant | Positive decoded assets | False-positive assets | Proposals | Clusters | Processed reps | Decode attempts |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `proposal-score` | 36 | 0 | 64,690 | 4,471 | 4,288 | 1,859,568 |
| `timing-score` | 36 | 0 | 64,690 | 4,471 | 4,285 | 1,854,777 |
| `quiet-timing-score` | 36 | 0 | 64,324 | 4,471 | 4,296 | 1,863,814 |
| `decode-signal-score` | 36 | 0 | 64,324 | 4,471 | 4,266 | 1,850,060 |
| `view-diverse-score` | 36 | 0 | 64,690 | 4,471 | 4,288 | 1,859,568 |

Compared with `proposal-score`:

```text
timing-score:
  positive delta = 0
  false-positive delta = 0
  lost/gained positives = 0/0
  processed representative delta = -3
  decode attempt delta = -4,791
  changed assets by attempts/reps/proposals = 101

quiet-timing-score:
  positive delta = 0
  false-positive delta = 0
  lost/gained positives = 0/0
  processed representative delta = +8
  decode attempt delta = +4,246
  changed assets by attempts/reps/proposals = 83

decode-signal-score:
  positive delta = 0
  false-positive delta = 0
  lost/gained positives = 0/0
  processed representative delta = -22
  decode attempt delta = -9,508
  changed assets by attempts/reps/proposals = 71

view-diverse-score:
  positive delta = 0
  false-positive delta = 0
  lost/gained positives = 0/0
  processed representative delta = 0
  decode attempt delta = 0
  changed assets by attempts/reps/proposals = 0
```

`decode-signal-score` had the strongest representative-order work reduction, but its decode-attempt reduction came from negatives overall:

```text
decode-signal-score attempt delta by label:
  positives = +1,388
  negatives = -10,896
  total = -9,508
```

`timing-score` was weaker overall but more balanced:

```text
timing-score attempt delta by label:
  positives = -2,651
  negatives = -2,140
  total = -4,791
```

`view-diverse-score` is a no-op at `maxClusterRepresentatives=1`; its scan-time differences are measurement noise and should not be treated as a representative-priority win from this run.

Regression fixture check: `asset-0944aec7c73146f9` (`coronatest`) stayed decoded in one attempt for every variant.

## Conclusion / evidence-backed decision

Do not canonize from this run alone. All variants preserved decode accuracy, but the best representative-order candidate depends on the objective:

- `decode-signal-score` is the lead if optimizing total representative/decode work, with `-22` processed representatives and `-9,508` decode attempts.
- `timing-score` is the safer balanced candidate if positive-asset effort matters more, with `-2,651` positive decode attempts and `-4,791` total attempts.
- `quiet-timing-score` should be binned for now because it increases representatives and attempts.
- `view-diverse-score` should be retested only with `maxClusterRepresentatives > 1` or after adding `decode-view-priority`; it has no effect with one representative.

Next step: run a narrow confirmation comparing `proposal-score`, `timing-score`, and `decode-signal-score`, or add per-view decode contribution before deciding whether decode-oriented view priority should be part of representative selection.
