# Module Sampling Hot Path Study

## Problem / question

Decode attempts sample QR modules through geometry transforms and binary pixel reads. The previous view study attributed hundreds of seconds to module sampling and billions of sampled modules. The study asks:

> Can module sampling be made cheaper by removing object allocation, repeated helper calls, and byte-oriented pixel reads while preserving decoded matrices and payloads?

The unit of decision is the module sampler implementation used by decode attempts. A clear result would change production sampling internals, not decode budgets or view/proposal ordering.

## Hypothesis / thesis

Module sampling is a tight numeric loop. Avoiding per-module point objects, repeated `samplePoint` calls, `Math.round`/clamp overhead where safe, and `0/255` binary helper conversions should reduce time per sampled module.

Null hypothesis: Reed-Solomon/bitstream decode or geometry math dominates the sampled path, so sampler micro-optimization does not improve normalized module-sampling time enough to justify complexity.

## Designed experiment / study

Run paired baseline/candidate scans on the same corpus and seed. Keep decode attempts identical by preserving proposal order, geometry candidate order, decode neighborhoods, and rescue behavior.

Candidate variants may be studied independently:

1. direct-bit binary reads only;
2. allocation-free point sampling;
3. row-wise homography stepping or precomputed grid coordinates;
4. preallocated module buffers;
5. combined optimized sampler.

Record nested timing carefully: `decode-attempt` includes `module-sampling`, so improvements should be evaluated per sampled module and per decode attempt.

## Metrics table

| Metric | Unit | Source | Decision use |
| --- | --- | --- | --- |
| Module-sampling duration | ms | `module-sampling` spans | Primary performance metric. |
| Sampled module count | count | module-sampling metadata | Normalization denominator. |
| Duration per sampled module | ns/module | study-derived metric | Primary normalized metric. |
| Decode-attempt duration | ms | `decode-attempt` spans | Secondary nested metric. |
| Decode success count | count | trace/study report | Must not regress. |
| Decoded matrix diff | exact diff | paired comparator | Must be identical before bitstream decode where possible. |
| Payload/result diff | exact diff | paired comparator | Must be empty or fully explained. |
| Allocation count/heap delta | bytes/count | optional profiler | Confirms allocation-free change. |

## Decision rule

Adopt sampler changes if:

- decoded payloads and success counts are unchanged;
- sampled module count remains unchanged for identical decode attempts;
- p50 and p95 duration per sampled module improve by at least 10%;
- no candidate variant introduces precision differences that change matrix bits except where a separate accuracy study approves them.

If combined changes improve speed but introduce diffs, bisect variants and adopt only exact-preserving pieces.

## Implementation checklist

- [ ] Add a paired sampler comparator capable of recording sampled matrix equality for selected attempts.
- [ ] Add direct-bit binary read path for samplers.
- [ ] Remove per-module `{ x, y }` object allocation from hot loops.
- [ ] Evaluate row-wise coordinate stepping or precomputed sample coordinates.
- [ ] Reuse output buffers where safe.
- [ ] Report normalized ns/module metrics by version/grid size and sampler variant.

## Results

Placeholder. Include variant-by-variant normalized timings and any matrix/payload diffs.

## Interpretation plan

Normalize by sampled module count and QR version. A large v40 candidate has a very different sampling profile from v1. Also separate successful and failed decode attempts: failed attempts may still pay full sampling cost and dominate runtime.

## Conclusion / evidence-backed decision

Placeholder. Document adopted sampler variant, exactness evidence, and measured speedup.
