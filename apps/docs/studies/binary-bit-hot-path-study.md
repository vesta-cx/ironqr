# Binary Bit Hot Path Study

## Problem / question

IronQR now stores binary threshold planes as polarity-free `0 | 1` byte planes, but the hottest proposal and sampling loops still often read through byte-oriented helpers that return `0 | 255`. The study asks:

> Does replacing byte-oriented binary pixel reads with direct bit-plane reads reduce detector and module-sampling time without changing proposal, decode, or accuracy behavior?

The unit of decision is the binary pixel read primitive used by finder detection, cross-checks, quiet-zone/timing scoring, and module sampling. A clear result would change production internals by routing hot loops through a direct `data[index] ^ polarityMask` reader while preserving public `0/255` helpers for diagnostics.

## Hypothesis / thesis

Direct `0 | 1` reads should reduce CPU overhead in loops that perform millions or billions of binary samples. The benefit should appear as lower detector and module-sampling timing with identical decoded payloads, proposal identities, and trace counts.

Null hypothesis: direct bit reads do not measurably reduce wall-clock time, or they alter proposal/decode results. In that case, keep the simpler byte-oriented call sites until a larger data-layout change, such as packed planes or run maps, justifies the churn.

## Designed experiment / study

Run paired scans on the same corpus and seed:

1. baseline branch: current byte-oriented hot loops;
2. candidate branch: direct binary bit readers in proposal detectors and samplers.

Use the same `view-proposals` configuration that processes all binary views, with cache refresh for both runs. Do not change view order, proposal budgets, cluster budgets, decode neighborhoods, or early-exit behavior between runs.

Separate timings into:

- independent wall-clock per asset;
- proposal generation/detector timings;
- module-sampling timings;
- decode-attempt timings, which include module sampling and decode work;
- materialization timings, which should remain mostly unchanged.

## Metrics table

| Metric | Unit | Source | Decision use |
| --- | --- | --- | --- |
| Positive decoded assets | assets | study summary | Must not regress. |
| False-positive assets | assets | study summary | Must not increase. |
| Proposal count by view | count | proposal trace summary | Must remain equal unless intentionally explained. |
| Ranked proposal count by view | count | study per-view metrics | Must remain equal unless score semantics changed, which this study should avoid. |
| Detector duration | ms | `proposal-view` spans | Primary performance metric. |
| Module-sampling duration | ms | `module-sampling` spans | Primary performance metric. |
| Sampled module count | count | module-sampling metadata | Normalize module-sampling cost. |
| Decode-attempt duration | ms | `decode-attempt` spans | Secondary, nested metric. |
| Binary plane materialization | ms | `binary-plane` spans | Should not materially change. |
| Payload/result diff | exact diff | paired report comparator | Must be empty or fully explained. |

## Decision rule

Adopt the direct-bit reader if:

- positive decoded assets do not decrease;
- false positives do not increase;
- proposal/result diffs are empty or attributable only to ordering ties with identical decoded output;
- p50 and p95 detector duration per asset improve by at least 5%, or module-sampling duration per sampled module improves by at least 5%.

If only one stage improves, adopt only the call sites for that stage.

## Implementation checklist

- [ ] Add a small internal binary reader abstraction that exposes `darkAt(index): 0 | 1` and `isDark(index): boolean` with polarity as XOR.
- [ ] Convert finder row scan, matcher, flood/component labeling, cross-checks, timing scoring, and quiet-zone scoring to direct-bit reads.
- [ ] Convert module samplers to direct-bit reads.
- [ ] Keep public diagnostic helpers returning `0 = dark`, `255 = light`.
- [ ] Add a paired-report comparator that flags result/proposal deltas.
- [ ] Record per-stage per-sample normalized timings in the study report.

## Results

Placeholder. Fill after running paired baseline/candidate reports.

## Interpretation plan

Prioritize normalized metrics, not only total time. A total-time win caused by fewer decode attempts is out of scope for this study and should be attributed to a behavior change, not a hot-path optimization.

If detector duration improves but module sampling does not, keep direct-bit detector changes and separately study sampler allocation/homography costs. If module sampling improves but detector duration does not, inspect whether detectors are dominated by run walking and should move to a run-map study.

## Conclusion / evidence-backed decision

Placeholder. Document the adopted call sites, measured speedup, report paths, and any intentionally accepted trace/output differences.
