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
- Inverted entries are polarity paths/signals over shared threshold planes, not separately materialized inverted planes.
- The next study iteration removes the old materialized-inverted (`a`) and shared-run-artifact (`b`) candidates; those answered the XOR/polarity-read question. The active candidate set now targets matcher speedups directly.

Question coverage:

| Study-doc question / metric | Status | Report evidence | Interpretation |
| --- | --- | --- | --- |
| Do cheap signals identify detector hotspots? | Answered for this sample | signal rows + detector durations | Yes. Dark ratio, matcher count, and deduped finder count correlate with detector time; hottest paths are inverted Sauvola. |
| Do signals predict proposal quality? | Partially answered | proposal counts only | Proposal count exists, but ranked proposal count, score, and structure pass/fail count are missing. Count alone is not quality. |
| Do signals predict decode success? | Unanswered | `decode=false` | No decode success or unique-positive evidence was collected. |
| Do signals predict false-positive risk? | Unanswered | `decode=false` | No false-positive evidence was collected. |
| Is signal collection cheap enough for study observability? | Answered for this sample | signalMs vs detectorMs | Yes. Total signal overhead was ~1.15% of detector time; p95 per-asset overhead was ~2.41%, under the 3% rule. |
| Does materializing inverted buffers beat polarity-proxy reads? | Answered for this smoke sample | retired `materialized-inverted-detector` variant | The old candidate improved total inverted detector+materialization time by 3.5% with equal finder/proposal counts, below the 5% checkpoint threshold; polarity-read/XOR overhead is not the main target. |
| Is shared polarity-neutral detector structure promising? | Partially answered | retired `shared-run-artifact-prototype` variant | The old candidate showed headroom but was too broad. The active study now decomposes matcher-specific run maps, center pruning, seeded rescue, and fused polarity traversal. |
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

Retired variant results:

| Variant | Control | Candidate | Delta | Improvement | Behavior evidence | Interpretation |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| materialized inverted detector | 118,662.49 ms | 114,504.65 ms | 4,157.84 ms | 3.5% | proposal/finder counts equal | Below the <5% checkpoint threshold; polarity-read/XOR overhead is unlikely to be the main inverted cost. |
| shared run artifact prototype | 204,322.80 ms | 1,143.55 ms | 203,179.25 ms | 99.44% | not behavior-equivalent | Strong headroom signal, but too broad to identify the matcher implementation shape. Replaced by matcher-specific candidates. |

Active matcher-candidate study revision:

| Variant id | Purpose | Behavior-equivalent? | Notes |
| --- | --- | --- | --- |
| `matcher-run-map-crosscheck` | Default production matcher control: row/column run-map-backed cross-checks replace repeated pixel walking. | Yes | Promoted after 25-asset equality evidence (`0` mismatched views). Future runs use this as control, not an extra candidate. |
| `matcher-candidate-pruning-prototype` | Run the run-map matcher with cheap local center-signal filtering and compare finder output signatures to control. | Yes, study-enforced | Candidate `b`; report includes sampled centers, survivors, output equality, and mismatch counts. |
| `matcher-seeded-rescue-estimate` | Count how many row-scan/flood finder centers could seed matcher refinement/rescue. | No, evidence-count only | Keeps the stylized-QR rescue question visible without pretending to time an implementation. |
| `matcher-fused-polarity-traversal-prototype` | Measure one shared-plane traversal that classifies normal-dark and inverted-dark centers together. | No | Candidate `d`; answers whether normal+inverted fusion is worth deeper work. |

## Matcher refinement checkpoint

The matcher-specific iteration added per-detector timing and then promoted one candidate to production:

1. Per-view proposal summaries now split detector time into row-scan, flood, matcher, and dedupe buckets.
2. `binary-prefilter-signals` emits those buckets to the study report and the live detector timing chart. Live timing bars include `p=<count>`: proposal count for view bars and finder-evidence count for detector/candidate bars.
3. The first matcher candidate made row/column run maps and used them for matcher cross-checks instead of repeatedly walking pixels.
4. The study compares candidate `FinderEvidence` signatures against the control matcher: source, center, module sizes, and score rounded to three decimals.
5. After the 25-asset equality run, the run-map matcher became the production/default matcher control in `packages/ironqr/src/pipeline/proposals.ts`.

Durable 25-asset checkpoint evidence from the run generated at `2026-04-25T02:22:24.459Z` on commit `fb8c1508d86f1d21fdeee384ec8cf8d54c62639a`:

| Measurement | Value |
| --- | ---: |
| Assets | 25 (`8` positive, `17` negative) |
| View rows | 1,350 (`25 × 54`) |
| Detector time | 205,798.40 ms |
| Matcher control time | 151,921.40 ms |
| Run-map matcher candidate time | 24,769.57 ms |
| Run-map matcher improvement | 83.7% |
| Run-map matcher output equality | `true` |
| Run-map mismatched views | 0 |
| Center-pruned matcher candidate time | 3,042.27 ms |
| Center-pruned matcher output equality | `false` |
| Center-pruned mismatched views | 1,104 |

Interpretation:

- Run-map cross-checks are the right default: they preserve matcher output while removing most of the matcher cost.
- Center pruning is too aggressive as a hard gate. It rejected enough candidate centers to change outputs in most views. If revisited, it should likely become prioritization plus fallback, not an exclusion filter.
- Fused polarity traversal and row/flood seeded rescue stayed non-output-producing because they only count/classify possible work. They do not yet emit matcher `FinderEvidence[]`, so they cannot prove equivalence.
- Future study runs are expected to be faster because the production matcher control now uses run maps by default.

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

The retired materialized-inverted candidate answered the immediate XOR-vs-interaction question for the smoke sample: materializing inverted buffers reduced inverted detector+materialization time by only 3.5% while preserving finder/proposal counts. That suggests polarity-read/XOR overhead is not the main cause of inverted cost. Most of the cost appears to come from matcher interaction with inverted semantics and repeated detector traversal.

The active candidate set now focuses on matcher-specific implementation shapes: cheap center pruning on top of the run-map matcher, row/flood seeded rescue, and fused normal+inverted traversal over the shared threshold plane. Run-map-backed cross-checks are now the default matcher control after output-equality evidence. The center-pruning candidate is output-producing and compares finder signatures to the control matcher. Seeded rescue and fused polarity traversal remain prototype/headroom measurements until they produce matcher finder lists and prove finder/proposal equivalence.

`binaryViewMs` remains effectively zero compared with detector time, confirming that inverted view identities are cheap proxies. Optimization should target detector traversal/artifact reuse, not binary-view wrapper construction.

## Conclusion / evidence-backed decision

Keep passive binary signals in study reports. They are cheap enough for study use and explain detector hotspots well enough to guide follow-up work.

This run does **not** answer the full problem statement. It answers the detector-hotspot and signal-overhead questions for the 25-asset sample, partially answers proposal-yield behavior, answers the materialized-inverted smoke question, and does not answer decode success or safe production gating.

Checkpoint decisions:

- Do not prioritize cached materialized inverted views yet; the retired materialized-inverted candidate improved only 3.5%, below the predeclared <5% threshold for deprioritization.
- Treat run-map-backed matcher cross-checks as the default control. Cheap center pruning needs mismatch analysis before it can gate matcher work, and should probably become prioritization/fallback rather than a hard filter.
- Keep the fused normal+inverted traversal candidate as a secondary question: useful if it falls out of shared-plane matcher artifacts, but unlikely to beat pruning/cross-check reuse alone.
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

- rerun `binary-prefilter-signals` after the run-map matcher promotion to quantify the new control cost across the same 25-asset sample and the full corpus;
- rerun `view-proposals` so proposal ranking, structure, cluster, and decode outcomes are measured against the faster matcher default;
- if center pruning is revisited, report both a fast-first candidate and a fallback-to-full-matcher candidate so speed and output equivalence are evaluated together;
- make fused polarity traversal output-producing before using it for a production decision: it must emit finder lists for normal and inverted views and prove equality against the default matcher;
- verify any candidate prefilter thresholds against unique positive successes and false-positive risk.
