# Scalar Materialization Fusion Study

## Problem / question

RGB/gray scalar views and OKLab-derived scalar views are currently materialized as individual planes. Exhaustive studies touch every scalar, which can repeat RGBA alpha compositing and OKLab encoding passes. The study asks:

> Does fusing related scalar-view materialization into shared passes reduce scalar materialization cost without changing binary planes or scan results?

The unit of decision is the scalar materialization family: RGB/gray and OKLab. A clear result would change production `ViewBank` internals so one request can populate sibling scalar views when the shared source pass is already paid.

## Hypothesis / thesis

RGB-family scalar views can be built in one pass over RGBA. OKLab encoded scalar views can be built in one pass over cached OKLab planes. Fusing these loops should reduce repeated source-buffer reads and math when multiple related scalars are used.

Null hypothesis: lazy single-view production scans do not benefit enough, or eager sibling materialization increases cost/memory when only one scalar is needed.

## Designed experiment / study

Run three paired configurations:

1. exhaustive view study using all 54 binary views;
2. production shortlist scan using current proposal view ids;
3. single-view targeted scans for representative views (`gray:otsu:normal`, `oklab-l:sauvola:normal`, and one RGB channel view).

Candidate behavior:

- materialize `gray`, `r`, `g`, and `b` in one RGBA pass when a fused RGB mode is enabled;
- materialize `oklab-l`, `oklab+a`, `oklab-a`, `oklab+b`, and `oklab-b` in one OKLab encoding pass when a fused OKLab mode is enabled;
- preserve lazy behavior by measuring both eager-family and demand-driven variants.

## Metrics table

| Metric | Unit | Source | Decision use |
| --- | --- | --- | --- |
| RGB family build duration | ms | new `scalar-family` span | Primary metric for RGB/gray fusion. |
| OKLab family build duration | ms | new `scalar-family` span | Primary metric for OKLab fusion. |
| Individual scalar-view duration | ms | existing `scalar-view` spans | Backward-compatible detail. |
| Scalar cache bytes | bytes | study metadata | Memory tradeoff. |
| Number of unused sibling planes | count | study metadata | Detects lazy-production waste. |
| Binary plane equality | exact diff | paired comparator | Must be identical. |
| Positive decoded assets | assets | study summary | Must not regress. |
| False-positive assets | assets | study summary | Must not increase. |
| Total scan wall-clock | ms | per-asset report | Secondary end-to-end check. |

## Decision rule

Adopt fusion only for a family/configuration if:

- scalar values and downstream binary planes are byte-identical to baseline;
- decoded assets and false positives are unchanged;
- exhaustive or production-shortlist scalar materialization improves by at least 15%;
- single-view scans do not regress by more than 3% wall-clock or an agreed absolute threshold.

If eager family materialization hurts single-view scans, implement demand-driven fused builders that populate siblings only when the second member of a family is requested.

## Implementation checklist

- [ ] Add family-level scalar cache helpers for RGB/gray and OKLab encoded planes.
- [ ] Add `scalar-family` timing spans with built ids and unused sibling count.
- [ ] Preserve `getScalarView(id)` public behavior.
- [ ] Add byte-equality tests for scalar views and derived binary planes.
- [ ] Run exhaustive, production-shortlist, and single-view paired studies.

## Results

Placeholder. Include separate RGB and OKLab family results, plus single-view regression checks.

## Interpretation plan

Separate cold-start single-view behavior from multi-view reuse. Fusion is valuable only where the workload actually requests siblings. If production normally requests `gray` and `oklab-l` but not all chroma views, a partial fusion may be better than all-family eager materialization.

## Conclusion / evidence-backed decision

Placeholder. Document adopted fusion mode, report paths, and any workload where fusion remains disabled.
