# Threshold Statistics Cache Study

## Problem / question

Otsu, Sauvola, and hybrid thresholding reuse scalar statistics, but the current view materialization path can recompute histograms, Otsu thresholds, and integral images for the same scalar plane. The study asks:

> Does caching scalar histograms, Otsu thresholds, and integral images reduce binary-plane materialization time enough to justify the memory overhead?

The unit of decision is the scalar-view statistics cache. A clear result would change production `ViewBank` internals by lazily caching statistics behind scalar views.

## Hypothesis / thesis

Across the exhaustive 54-view study, each scalar view is thresholded by Otsu, Sauvola, and hybrid. Hybrid needs both Otsu threshold and local integral statistics; Sauvola needs local integral statistics. Reusing these dependencies should reduce repeated full-plane work.

Null hypothesis: binary-plane materialization is too small relative to detector/decode time, or cached integral images cost too much memory for the speedup.

## Designed experiment / study

Run paired baseline/candidate studies with all 54 binary views enabled and cache refresh.

Candidate behavior:

- lazily cache `Uint32Array(256)` histogram per scalar view;
- lazily cache Otsu threshold derived from the histogram;
- lazily cache summed-area tables for scalar sum and square sum;
- use cached Otsu threshold in Otsu and hybrid;
- use cached integral images in Sauvola and hybrid.

No view/proposal/decode budgets or early exits should change. The study should report memory overhead by scalar view and threshold family.

## Metrics table

| Metric | Unit | Source | Decision use |
| --- | --- | --- | --- |
| Histogram build duration | ms | new `scalar-histogram` span | Measures Otsu dependency cost. |
| Otsu threshold duration | ms | new or nested threshold metadata | Confirms histogram reuse. |
| Integral image build duration | ms | new `scalar-integral` span | Measures adaptive dependency cost. |
| Binary plane materialization duration | ms | `binary-plane` spans | Primary performance metric. |
| Binary plane duration by threshold | ms | study per-threshold summary | Shows Otsu/Sauvola/hybrid impact. |
| Cache hit count by dependency | count | study metrics | Proves reuse happened. |
| Cache bytes by scalar | bytes | study metadata | Memory tradeoff. |
| Positive decoded assets | assets | study summary | Must not regress. |
| False-positive assets | assets | study summary | Must not increase. |
| Bit-plane equality | exact diff | paired comparator | Must be identical for same scalar/threshold. |

## Decision rule

Adopt the cache if:

- all generated binary planes are bit-identical to baseline;
- positive and false-positive asset counts are unchanged;
- inclusive binary-plane materialization time improves by at least 20% for Sauvola+hybrid combined, or by at least 10% across all thresholds;
- memory overhead is acceptable for the largest supported image class.

If integral images are too expensive, adopt histogram/Otsu caching independently and leave adaptive stats uncached.

## Implementation checklist

- [ ] Extend derived view cache with scalar statistic entries.
- [ ] Add lazy `getScalarHistogram`, `getOtsuThreshold`, and `getIntegralStats` helpers.
- [ ] Replace Otsu/hybrid threshold computation with cached threshold lookup.
- [ ] Replace Sauvola/hybrid integral construction with cached integral lookup.
- [ ] Add dependency timing spans and cache hit/miss counters.
- [ ] Add tests that binary planes are byte-for-byte identical before/after caching.

## Results

Placeholder. Include total and per-threshold materialization deltas, cache hit/miss counts, and memory overhead.

## Interpretation plan

Do not overvalue total scan-time percentage if decode attempts dominate a run. The relevant question is whether the thresholding subsystem itself becomes cheaper without accuracy risk and within memory budget.

Compare cold and warm materialization separately. Cold cost matters for single-view production scans; warm reuse matters for exhaustive studies and multi-view production scans.

## Conclusion / evidence-backed decision

Placeholder. Document which cached dependencies ship, memory budget, and report evidence.
