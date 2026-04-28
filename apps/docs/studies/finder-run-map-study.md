# Finder Run Map Study

## Problem / question

Finder detection repeatedly scans binary planes for horizontal and vertical runs. Row scan, matcher, cross-checks, timing checks, and some plausibility checks all rediscover local run structure independently. The study asks:

> Does building reusable row/column run maps for each binary view reduce finder/proposal detector time while preserving proposal coverage and decode results?

The unit of decision is the per-binary-view run representation used by proposal generation. A clear result would change production by caching run maps beside binary planes and using them for finder evidence and cross-checks.

## Hypothesis / thesis

Binary planes are row-major, so horizontal scans are cache-friendly while vertical cross-checks are repeated strided memory walks. A reusable run map should trade one sequential pass per axis for faster candidate validation and fewer repeated pixel reads.

Null hypothesis: run-map construction overhead and memory pressure outweigh the saved detector work, or run quantization changes finder evidence enough to reduce positive coverage.

## Designed experiment / study

Run paired baseline/candidate studies across the approved corpus with all 54 binary views enabled.

Candidate behavior:

- build row runs lazily on first row-scan/cross-check use;
- build column runs lazily on first vertical cross-check use;
- represent run color as `0 | 1` dark bit after polarity application;
- keep the same finder ratio tolerance, clustering, scoring, and decode cascade.

Do not use run maps to skip views or proposals. This study measures a data representation change, not a budget or gating policy.

## Metrics table

| Metric | Unit | Source | Decision use |
| --- | --- | --- | --- |
| Run-map build duration | ms | new `run-map` timing span | Separates setup cost from detector savings. |
| Row run count / column run count | count | run-map metadata | Explains memory and noisy-view behavior. |
| Detector duration | ms | `proposal-view` spans | Primary performance metric. |
| Row-scan finder count | count | proposal summary | Must preserve candidate evidence. |
| Matcher finder count | count | proposal summary | Must preserve candidate evidence. |
| Flood finder count | count | proposal summary | Should not regress if flood still runs. |
| Proposal count / ranked proposal count | count | per-view report | Must remain close or better explained by exact duplicate collapse. |
| Positive decoded assets | assets | study summary | Must not regress. |
| False-positive assets | assets | study summary | Must not increase. |
| Peak run-map bytes | bytes | study metadata | Used for memory tradeoff. |

## Decision rule

Adopt run maps if:

- positive decoded assets do not decrease;
- false-positive assets do not increase;
- p95 detector duration improves by at least 10% on QR-positive assets or by at least 15% on all assets;
- run-map memory stays within an agreed per-megapixel budget;
- proposal diffs do not remove any successful proposal path.

If row maps help but column maps are too expensive, adopt row maps only and keep vertical checks direct-bit until more evidence exists.

## Implementation checklist

- [ ] Add a `BinaryRunMap` cache keyed by binary view id or by threshold plane plus polarity.
- [ ] Add `run-map` timing spans with row/column run counts and estimated bytes.
- [ ] Rework row-scan finder detection to iterate row runs instead of pixels.
- [ ] Rework cross-checks to use row/column run lookup.
- [ ] Evaluate matcher iteration over plausible dark run centers rather than sampled pixels.
- [ ] Add paired-result diff tooling for finder evidence, proposals, and decodes.

## Results

Placeholder. Fill with paired report paths, timing deltas, memory overhead, and any proposal/decode diffs.

## Interpretation plan

Analyze positive and negative assets separately. Negative/noisy assets may create many runs and reveal memory regressions. Positive assets show whether run-map construction pays for itself on successful scans.

Nested timings matter: detector duration should be compared both including and excluding run-map build time. Production adoption should use the inclusive number.

## Conclusion / evidence-backed decision

Placeholder. Document whether row maps, column maps, both, or neither are adopted, and link the report proving no positive coverage loss.
