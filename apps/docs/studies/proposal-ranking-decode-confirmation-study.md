# Proposal Ranking Decode Confirmation Study

## Problem / question

The geometry decode run showed that hard proposal rejection can gain positives under bounded search, but can also lose an easy baseline positive. This study asks whether reordering proposals with stronger decode-likelihood signals improves decode work without deleting candidates.

## Hypothesis / thesis

Ranking candidates with stronger timing, quiet-zone, and alignment weights should try decodable proposals earlier than the baseline score. The null hypothesis is that the current ranking is already best, or that stronger decode-signal weighting loses positives or increases false positives.

## Designed experiment / study

Run:

```bash
bun run bench study proposal-ranking-decode-confirmation --refresh-cache
```

Default variants:

| Variant | Purpose |
| --- | --- |
| `baseline` | Current canonical proposal ranking. |
| `timing-heavy` | Increases grid timing-line score weight. |
| `quiet-timing-heavy` | Increases quiet-zone, timing, and alignment evidence. |
| `decode-signal-heavy` | Strongest decode-likelihood weighting; downweights detector prior and increases penalties. |

Defaults:

```text
detectorPolicy=no-flood
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
| Lost/gained positive asset ids | asset ids | Explain rank regressions/improvements. |
| Cluster count / processed representatives | count | Frontier work after ranking. |
| Decode attempts / successes | count | Decode effort and outcome. |
| Ranking, structure, geometry, module-sampling, decode timings | ms | Cost attribution. |

## Decision rule

Advance a ranking variant only if, relative to `baseline`:

```text
lost positive asset ids = []
false-positive asset delta <= 0
positive decoded asset delta >= 0
decode attempts and/or scan time improve materially
```

If using a bounded `--max-decode-attempts`, treat gains as budget-ordering evidence, not proposal-set coverage evidence.

## Results

Full unbounded decode run generated `2026-04-26T10:41:50.628Z` from commit `e8e82a45b215fc9da8d7046b9176791d5a805d9d` with dirty working tree state. Reports:

```text
tools/bench/reports/full/study/study-proposal-ranking-decode-confirmation.json
tools/bench/reports/study/study-proposal-ranking-decode-confirmation.summary.json
```

Run shape:

```text
variants=baseline,timing-heavy,quiet-timing-heavy,decode-signal-heavy
assets=203 positives=60 negatives=143
maxProposals=24 maxClusterRepresentatives=1 maxDecodeAttempts=unbounded maxViews=54
cache hits=0 misses=406 writes=203
```

| Variant | Positive decoded assets | False-positive assets | Proposals | Clusters | Processed reps | Decode attempts | Scan ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `baseline` | 34 | 0 | 64,667 | 4,459 | 4,320 | 1,862,563 | 6,425,619.44 |
| `timing-heavy` | 36 | 0 | 64,690 | 4,471 | 4,288 | 1,859,568 | 6,363,785.08 |
| `quiet-timing-heavy` | 36 | 0 | 64,212 | 4,469 | 4,259 | 1,972,499 | 7,191,548.98 |
| `decode-signal-heavy` | 36 | 0 | 64,651 | 4,471 | 4,254 | 2,218,612 | 8,781,559.34 |

Compared with `baseline`:

```text
timing-heavy:
  positive delta = +2
  false-positive delta = 0
  proposal delta = +23
  processed representative delta = -32
  decode attempt delta = -2,995
  scan delta = -61,834.36ms
  lost/gained positives = 0/2

quiet-timing-heavy:
  positive delta = +2
  false-positive delta = 0
  proposal delta = -455
  processed representative delta = -61
  decode attempt delta = +109,936
  scan delta = +765,929.54ms
  lost/gained positives = 0/2

decode-signal-heavy:
  positive delta = +2
  false-positive delta = 0
  proposal delta = -16
  processed representative delta = -66
  decode attempt delta = +356,049
  scan delta = +2,355,939.90ms
  lost/gained positives = 0/2
```

All ranking variants preserved baseline positive decodes and false-positive behavior. All three gained the same positive assets:

```text
asset-532613e8ac453b24  expected="https://qr.thaichana.com/?appId=0001&shopId=S0000002150"
asset-bd783ed07a05b5d3  expected="https://www.instagram.com/wir.sind.klein/?hl=de"
```

`timing-heavy` is the only variant that improved recall and reduced total decode work. The two stronger variants gained the same positives but substantially increased decode attempts and scan time, so their weights are too aggressive.

Regression check: the easy `coronatest` asset that hard timing-corridor rejection lost remained decoded by every ranking variant in 1 attempt.

## Conclusion / evidence-backed decision

`timing-heavy` is the lead proposal-prioritization candidate. It satisfies the decision rule: no lost positives, no false-positive increase, +2 positive decoded assets, fewer processed representatives, fewer decode attempts, and lower scan time under unbounded decode.

Do not promote `quiet-timing-heavy` or `decode-signal-heavy`: both preserve recall and gain the same two positives, but they increase decode attempts and scan duration materially.

Next step: run a bounded production-budget confirmation for `baseline` vs `timing-heavy`:

```bash
bun run bench study proposal-ranking-decode-confirmation \
  --variants baseline,timing-heavy \
  --max-decode-attempts 200 \
  --refresh-cache
```

If the bounded run also has no lost positives, no false-positive increase, and equal or better decoded positives, `timing-heavy` is a strong canonization candidate.
