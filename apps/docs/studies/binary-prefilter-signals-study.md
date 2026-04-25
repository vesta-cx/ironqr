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

- [ ] Add per-view signal collection behind study/report plumbing.
- [ ] Emit signal collection timing separately from detector timing.
- [ ] Add correlation summaries by scalar, threshold, polarity, and asset label.
- [ ] Keep signals passive: no skipping, budget changes, or detector parameter changes.
- [ ] If signals are useful, design a separate gating or detector-parameter study.

## Results

Placeholder. Include signal distributions and correlations with detector cost/proposal yield/success.

## Interpretation plan

Treat signals as explanatory first. A signal that identifies low-yield views is not automatically a production prefilter; it must be validated against unique successes and hard positives. Signals that identify high-cost views may still be useful for optimizing masks or detector paths without skipping those views.

## Conclusion / evidence-backed decision

Placeholder. Document which signals become durable observability and which require follow-up studies.
