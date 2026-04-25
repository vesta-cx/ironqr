# Binary Prefilter Signals Study

## Problem / question

Several cheap whole-view signals may explain expensive detector behavior: black/white ratio, transition density, approximate finder-run count, component counts, and noisy-view run density. The immediate question is not whether to skip views, but whether these signals identify image-processing hotspots and reusable mask features.

> Which whole-view binary signals predict detector cost, proposal quality, and decode success strongly enough to guide later optimization or safe production gating?

The unit of decision is a per-binary-view signal set. A clear result would add durable observability and may later justify detector parameter changes or explicit prefilters.

## Hypothesis / thesis

Views with extreme dark ratio, too few transitions, too many transitions, or pathological component counts are likely expensive and low-yield. Measuring these signals should explain which threshold/scalar/polarity paths create detector work without successful decodes.

Null hypothesis: cheap whole-view signals do not correlate with detector cost, proposal count, or decode success enough to justify maintaining them.

## Designed experiment / study

Run the existing `view-proposals` study with additional per-view signal collection. Do not use the signals to skip work in this study.

Collect signals after binary-plane materialization and before proposal generation:

- dark ratio and light ratio;
- horizontal and vertical transition density;
- approximate finder-run hit count from a cheap row-run pass;
- connected-component count and size percentiles if component labels are already built;
- run count percentiles if run maps are available;
- duplicate/redundant similarity to sibling views if cheap to compute.

Analyze correlation against detector time, proposal count, ranked proposal count, structure pass count, decode success, and false positives.

## Metrics table

| Metric | Unit | Source | Decision use |
| --- | --- | --- | --- |
| Dark ratio | fraction | new view signal | Candidate explanatory feature. |
| Horizontal/vertical transition density | transitions/pixel | new view signal | Predicts run/detector cost. |
| Approx finder-run count | count | new signal | Predicts proposal yield. |
| Component count/percentiles | count/pixels | optional component artifact | Predicts flood cost/noise. |
| Signal collection duration | ms | new timing span | Must be cheap enough to keep. |
| Detector duration | ms | proposal-view spans | Correlation target. |
| Proposal/ranked proposal count | count | per-view report | Correlation target. |
| Structure pass count | count | trace metrics | Correlation target. |
| Decode success / false positive | count | study summary | Safety target for future gating. |

## Decision rule

Adopt signals as observability if:

- signal collection costs less than 3% of detector duration on p95 assets, or less than an agreed absolute threshold;
- at least one signal meaningfully explains detector cost, proposal yield, or decode success;
- the signal definitions are stable across corpus buckets.

Do not adopt production skipping from this study alone. A follow-up gating study must prove zero positive-regression on the current corpus or document an explicit product tradeoff.

## Implementation checklist

- [x] Add per-view signal collection behind study/report plumbing.
- [x] Emit signal collection timing separately from detector timing.
- [x] Add correlation summaries by scalar, threshold, polarity, and asset label in analysis output.
- [x] Keep signals passive: no skipping, budget changes, or detector parameter changes.
- [ ] If signals are useful, design a separate gating or detector-parameter study.

## Results

Source report:

```text
tools/bench/reports/study-binary-prefilter-signals.json
```

Run metadata:

- generated: `2026-04-25T01:02:59.799Z`
- commit: `abc53c4721e252d95f89a10a1f88ff67b83e5e6c`
- dirty state: `false`
- command: `bench study binary-prefilter-signals --view-set all --refresh-cache`
- corpus: 203 assets, 60 positive, 143 negative
- seed: `binary-prefilter-signals-b8ae0bfd479b350e`
- workers: 5
- config: `{ focus: "binary-prefilter-signals", viewSet: "all", decode: false }`
- cache: 0 hits, 203 misses, 203 writes

Report fitness notes:

- The run is suitable for materialization, passive signal, and proposal-detector timing analysis because cache hits were zero.
- The run is not a decode-capability or prefilter-safety proof because `decode=false`; it cannot report lost positives or false positives for a future gating policy.
- The report was generated before the later `summary.variants` report addition, so this analysis treats it as a passive signal/control run rather than a variant decision report.
- The study processed all 54 binary view identities over the shared threshold-plane model. Inverted entries are polarity paths/signals, not separately materialized inverted planes.

Headline totals:

| Metric | Value |
| --- | ---: |
| Pixel observations | 118,173,433 |
| Proposal generation wall time | 8,654,656.84 ms |
| Detector time | 1,696,725.33 ms |
| Scalar view materialization | 14,630.35 ms |
| Binary plane materialization | 38,248.43 ms |
| Binary view wrapper materialization | 91.51 ms |
| Passive signal collection | 20,547.84 ms |
| Histogram measurement | 14,180.45 ms |
| Integral measurement | 4,282.12 ms |
| Study-side RGB fusion prototype | 2,055.71 ms |
| Study-side OKLab fusion prototype | 9,621.42 ms |
| Estimated shared polarity artifact saving | 10,578.41 ms |

Detector hotspots by view:

| View | Detector time | Proposals | Row finders | Matcher finders | Avg dark ratio | Avg H transitions | Avg V transitions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `oklab-l:sauvola:inverted` | 63.8s | 12,167 | 2,194 | 2,335 | 0.765 | 0.0375 | 0.0367 |
| `gray:sauvola:inverted` | 57.0s | 12,618 | 2,260 | 2,381 | 0.695 | 0.0444 | 0.0435 |
| `g:sauvola:inverted` | 56.3s | 12,867 | 2,255 | 2,384 | 0.691 | 0.0439 | 0.0430 |
| `b:sauvola:inverted` | 53.6s | 13,261 | 2,299 | 2,389 | 0.684 | 0.0464 | 0.0451 |
| `r:sauvola:inverted` | 53.2s | 12,439 | 2,244 | 2,335 | 0.678 | 0.0466 | 0.0454 |

Detector cost by family:

| Family | Detector time | Proposals | Notes |
| --- | ---: | ---: | --- |
| `gray` | 243.0s | 81,472 | Most expensive scalar family. |
| `oklab-l` | 240.0s | 82,096 | Similar cost/yield to gray. |
| `g` | 236.2s | 81,980 | RGB channels are also high-cost. |
| `r` | 235.4s | 79,165 | RGB channels are also high-cost. |
| `b` | 232.6s | 80,759 | RGB channels are also high-cost. |
| OKLab chroma families | 120.0s–132.4s each | ~33k–34k each | Much lower detector load in this run. |

Detector cost by threshold:

| Threshold | Detector time | Proposals | Notes |
| --- | ---: | ---: | --- |
| `otsu` | 654.5s | 189,474 | Highest detector time. |
| `hybrid` | 637.2s | 213,950 | Highest proposal count. |
| `sauvola` | 405.0s | 137,470 | Lower total detector time overall, but inverted Sauvola contains the top five hottest individual paths. |

Detector cost by polarity:

| Polarity | Detector time | Proposals | Flood finders | Notes |
| --- | ---: | ---: | ---: | --- |
| `inverted` | 953.9s | 261,962 | 476 | Higher detector time despite fewer proposals. |
| `normal` | 742.8s | 278,932 | 3,104 | More flood evidence, lower total detector time. |

Signal correlations with detector duration across per-asset/per-view rows:

| Signal | Correlation with detector duration |
| --- | ---: |
| Matcher finder count | 0.497 |
| Dark ratio | 0.413 |
| Row-scan finder count | 0.375 |
| Vertical run count | 0.243 |
| Horizontal run count | 0.231 |
| Vertical transition density | 0.200 |
| Horizontal transition density | 0.199 |
| Proposal count | 0.168 |

## Interpretation plan

Treat signals as explanatory first. A signal that identifies low-yield views is not automatically a production prefilter; it must be validated against unique successes and hard positives. Signals that identify high-cost views may still be useful for optimizing masks or detector paths without skipping those views.

This run supports keeping passive signal collection as study observability: signal collection was about 20.5s versus about 1,696.7s of detector work, or roughly 1.2% of detector time. The strongest predictors in this report are not raw transition density but matcher finder count, dark ratio, and row-scan finder count.

The hottest paths are concentrated in inverted Sauvola views with high dark ratios. That does not justify skipping inverted Sauvola, because this run did not decode and cannot measure unique positive loss. It does suggest two follow-up directions:

1. improve matcher/finder detector mechanics for dense dark inverted views; and
2. evaluate shared polarity-neutral detector artifacts, because normal and inverted have identical transition densities and shared threshold planes but still pay separate polarity-path detector costs.

`binaryViewMs` is effectively zero compared with `binaryPlaneMs`, confirming that inverted view identities are cheap proxies. Optimization should target detector use of the plane, not binary-view wrapper construction.

## Conclusion / evidence-backed decision

Keep passive binary signals in study reports. They are cheap enough for study use and explain detector hotspots well enough to guide follow-up work.

Do not ship production prefilter gating from this run. Required next evidence:

- rerun after `summary.variants` support so the report includes explicit control/candidate rows;
- run `view-proposals` or a decode-enabled follow-up to connect signals to unique positive successes and false-positive risk;
- prioritize `shared-binary-detector-artifacts` and `finder-run-map` candidate studies for the inverted Sauvola hotspot.
