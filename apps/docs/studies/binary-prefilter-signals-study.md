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

- generated: `2026-04-25T01:38:33.753Z`
- commit: `e6338e8b9810419c5091e8faedf5a08976bb88fb`
- dirty state: `false`
- command: `bench study binary-prefilter-signals --view-set all --refresh-cache --max-assets 25`
- corpus sample: 25 assets, 8 positive, 17 negative
- seed: `binary-prefilter-signals-879a5d3409df97f8`
- workers: 5
- config: `{ focus: "binary-prefilter-signals", viewSet: "all", decode: false }`
- cache: 0 hits, 25 misses, 25 writes

Report fitness notes:

- The run is suitable as a smoke-test checkpoint for detector timing, passive signal overhead, and the two current performance variants because cache hits were zero.
- The run covered all 54 binary view identities on a seeded 25-asset sample, not the full 203-asset corpus.
- The run is not a decode-capability or prefilter-safety proof because `decode=false`; it cannot report lost positives or false positives for a future gating policy.
- The run still does not fully match the original designed experiment because signal rows are not joined to exhaustive `view-proposals` trace outcomes. It lacks ranked proposal score, structure pass/fail, decode success, and false-positive outcomes per signal row.
- Inverted entries are polarity paths/signals over shared threshold planes, not separately materialized inverted planes, except for candidate `a`, which deliberately materializes inverted buffers to measure that hypothesis.

Question coverage:

| Study-doc question / metric | Status | Report evidence | Interpretation |
| --- | --- | --- | --- |
| Do cheap signals identify detector hotspots? | Answered for this sample | signal rows + detector durations | Yes. Dark ratio, matcher count, and deduped finder count correlate with detector time; hottest paths are inverted Sauvola. |
| Do signals predict proposal quality? | Partially answered | proposal counts only | Proposal count exists, but ranked proposal count, score, and structure pass/fail count are missing. Count alone is not quality. |
| Do signals predict decode success? | Unanswered | `decode=false` | No decode success or unique-positive evidence was collected. |
| Do signals predict false-positive risk? | Unanswered | `decode=false` | No false-positive evidence was collected. |
| Is signal collection cheap enough for study observability? | Answered for this sample | signalMs vs detectorMs | Yes. Total signal overhead was ~1.15% of detector time; p95 per-asset overhead was ~2.41%, under the 3% rule. |
| Does materializing inverted buffers beat polarity-proxy reads? | Answered for this smoke sample | `materialized-inverted-detector` variant | Candidate `a` improved total inverted detector+materialization time by 3.5% with equal finder/proposal counts, below the 5% checkpoint threshold. |
| Is shared polarity-neutral detector structure promising? | Partially answered | `shared-run-artifact-prototype` variant | Candidate `b` shows large headroom, but it only measures shared run construction and is not behavior-equivalent detector replacement yet. |
| Are component counts/percentiles useful? | Unanswered | not collected | Component stats were optional and not present. |
| Are duplicate/redundant sibling-view signals useful? | Unanswered | not collected | Similarity to sibling views was not present. |

Headline totals:

| Metric | Value |
| --- | ---: |
| Pixel observations | 15,192,640 |
| Proposal generation wall time | 1,038,960.91 ms |
| Detector time | 204,322.80 ms |
| Scalar view materialization | 1,812.48 ms |
| Binary plane materialization | 4,458.60 ms |
| Binary view wrapper materialization | 10.74 ms |
| Passive signal collection | 2,344.00 ms |
| Histogram measurement | 1,588.29 ms |
| Integral measurement | 489.68 ms |
| Study-side RGB fusion prototype | 231.98 ms |
| Study-side OKLab fusion prototype | 1,112.98 ms |
| Estimated shared polarity artifact saving | 1,192.43 ms |

Variant results:

| Variant | Control | Candidate | Delta | Improvement | Behavior evidence | Interpretation |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| `a` materialized inverted detector | 118,662.49 ms | 114,504.65 ms | 4,157.84 ms | 3.5% | proposal/finder counts equal | Below the <5% checkpoint threshold; polarity-read/XOR overhead is unlikely to be the main inverted cost. |
| `b` shared run artifact prototype | 204,322.80 ms | 1,143.55 ms | 203,179.25 ms | 99.44% | not behavior-equivalent | Strong headroom signal for shared run/component artifacts, but must be implemented as a real detector candidate before adoption. |

Detector hotspots by view:

| View | Detector time | Proposals | Row finders | Matcher finders | Avg dark ratio | Avg H transitions | Avg V transitions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `oklab-l:sauvola:inverted` | 8.0s | 1,064 | 242 | 288 | 0.786 | 0.0273 | 0.0241 |
| `gray:sauvola:inverted` | 7.1s | 1,259 | 263 | 293 | 0.721 | 0.0305 | 0.0271 |
| `r:sauvola:inverted` | 7.1s | 1,361 | 281 | 300 | 0.718 | 0.0351 | 0.0304 |
| `g:sauvola:inverted` | 7.0s | 1,288 | 263 | 296 | 0.720 | 0.0304 | 0.0273 |
| `b:sauvola:inverted` | 6.6s | 1,265 | 282 | 300 | 0.699 | 0.0342 | 0.0312 |

Detector cost by family:

| Family | Detector time | Proposals | Notes |
| --- | ---: | ---: | --- |
| `oklab-l` | 28.5s | 8,218 | Most expensive scalar family in this sample. |
| `gray` | 28.3s | 8,979 | Similar cost/yield to OKLab-L. |
| `r` | 28.0s | 8,060 | RGB channels remain high-cost. |
| `b` | 27.7s | 7,467 | RGB channels remain high-cost. |
| `g` | 27.3s | 8,878 | RGB channels remain high-cost. |
| OKLab chroma families | 15.5s–16.8s each | ~4k–4.9k each | Lower detector load in this sample. |

Detector cost by threshold:

| Threshold | Detector time | Proposals | Notes |
| --- | ---: | ---: | --- |
| `otsu` | 80.4s | 21,581 | Highest detector time. |
| `hybrid` | 75.3s | 23,378 | Highest proposal count. |
| `sauvola` | 48.6s | 14,504 | Lower aggregate detector time, but inverted Sauvola contains the top five hottest individual paths. |

Detector cost by polarity:

| Polarity | Detector time | Proposals | Flood finders | Notes |
| --- | ---: | ---: | ---: | --- |
| `inverted` | 118.7s | 27,056 | 78 | Higher detector time despite fewer proposals. |
| `normal` | 85.7s | 32,407 | 423 | More flood evidence, lower detector time. |

Signal correlations with detector duration across per-asset/per-view rows:

| Signal | Correlation with detector duration |
| --- | ---: |
| Deduped finder count | 0.536 |
| Matcher finder count | 0.532 |
| Dark ratio | 0.491 |
| Row-scan finder count | 0.386 |
| Vertical transition density | 0.196 |
| Vertical run count | 0.168 |
| Horizontal transition density | 0.172 |
| Horizontal run count | 0.149 |
| Proposal count | 0.099 |
| Flood finder count | -0.008 |

## Interpretation plan

Treat signals as explanatory first. A signal that identifies low-yield views is not automatically a production prefilter; it must be validated against unique successes and hard positives. Signals that identify high-cost views may still be useful for optimizing masks or detector paths without skipping those views.

This smoke run supports keeping passive signal collection as study observability. Signal collection was ~2.34s versus ~204.32s of detector work, or ~1.15% overall. The p95 per-asset signal overhead was ~2.41%, under the study's 3% adoption threshold for observability.

The strongest predictors in this run were deduped finder count, matcher finder count, and dark ratio. Raw transition density and run counts had weaker correlation. The hottest paths again concentrated in inverted Sauvola views with high dark ratios.

Candidate `a` answers the immediate XOR-vs-interaction question for the smoke sample: materializing inverted buffers reduced inverted detector+materialization time by only 3.5% while preserving finder/proposal counts. That suggests polarity-read/XOR overhead is not the main cause of inverted cost. Most of the cost appears to come from detector interaction with inverted semantics and repeated detector traversal.

Candidate `b` provides strong headroom evidence for shared polarity-neutral run artifacts. However, it is only a prototype measurement of shared run construction, not a detector replacement. The next candidate must consume those run artifacts inside finder row-scan/cross-check/matcher logic and prove behavior equivalence.

`binaryViewMs` remains effectively zero compared with detector time, confirming that inverted view identities are cheap proxies. Optimization should target detector traversal/artifact reuse, not binary-view wrapper construction.

## Conclusion / evidence-backed decision

Keep passive binary signals in study reports. They are cheap enough for study use and explain detector hotspots well enough to guide follow-up work.

This run does **not** answer the full problem statement. It answers the detector-hotspot and signal-overhead questions for the 25-asset sample, partially answers proposal-yield behavior, answers the materialized-inverted smoke question, and does not answer decode success or safe production gating.

Checkpoint decisions:

- Do not prioritize cached materialized inverted views yet. Candidate `a` improved only 3.5%, below the predeclared <5% threshold for deprioritization, although a full corpus run could confirm.
- Prioritize candidate `b`: implement a behavior-equivalent shared run/component artifact detector path, because the prototype shows large potential headroom and directly addresses repeated normal/inverted detector traversal.
- Do not ship production prefilter gating from this run.

Full refined experiment still needed for prefilter gating:

1. Integrate binary signal collection into the exhaustive `view-proposals` path instead of running it as a detached proposal-only study.
2. For each `proposal-view-generated` row, attach:
   - dark ratio and light ratio;
   - horizontal/vertical transition density;
   - horizontal/vertical run counts;
   - approximate finder-run candidate count from the cheap signal pass;
   - optional connected-component count and size percentiles;
   - optional sibling similarity for normal/inverted and scalar-family pairs.
3. Preserve exhaustive study behavior:
   - all 54 view identities;
   - 10k proposal/cluster/representative ceiling;
   - `allowMultiple: true`;
   - `continueAfterDecode: true`;
   - no signal-based skipping.
4. Reuse the `view-proposals` trace outputs to correlate signals against:
   - ranked proposal count;
   - proposal scores;
   - structure pass/fail count;
   - cluster representative count;
   - decode success and unique positive contribution;
   - false-positive count on negatives.
5. Add a candidate-threshold sweep as analysis-only rows, not production behavior:
   - compute which views/assets would be skipped by candidate signal thresholds;
   - report detector time avoided;
   - report unique positive assets lost;
   - report false positives avoided;
   - require zero unique-positive loss before considering a production prefilter.

Do not ship production prefilter gating from this run. Required next evidence:

- implement behavior-equivalent shared run/component detector candidate `b` and rerun the 25-asset smoke;
- rerun after signal rows are joined to `view-proposals` decode/structure evidence;
- verify any candidate thresholds against unique positive successes and false-positive risk.
