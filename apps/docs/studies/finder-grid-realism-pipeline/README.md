# Math-Based QR Realism Pipeline

This directory defines the next QR scanner realism pipeline as a sequence of small, empirical stages.

The goal is to stop treating “QR-looking” signals as one blurry score. Each stage should produce a concrete artifact that later stages can measure, cache, compare, and use for ranking or filtering.

## Pipeline shape

```text
01 image preprocessing
→ 02 scalar views
→ 03 binary views
→ 04 finder detection
→ 05 finder evidence construction
→ later: finder geometry refinement
→ later: finder triple construction
→ later: version/grid fitting
→ later: homography fitting
→ later: semantic QR checks
→ later: decode confirmation + threshold sweeps
```

## Rule for every stage

Each stage should document:

1. **Input**: what data it receives.
2. **Output artifact**: what it must emit.
3. **Math / algorithm**: how output is calculated.
4. **Why this signal exists**: what failure mode it helps.
5. **Empirical questions**: what the study should measure.
6. **Cache boundary**: whether this stage should be cached separately.

## Current-vs-target language

These docs intentionally distinguish:

- **Current pipeline**: what the code mostly does today.
- **Target realism pipeline**: the math-based artifacts we want to evolve toward.

The current pipeline already has good pieces: normalized frames, scalar views, binary views, row-scan/matcher detectors, proposal frontiers, cluster frontiers, and decode-confirmation studies.

The target pipeline adds richer finder geometry and shared-grid residuals so we can ask:

```text
Can this finder evidence mathematically explain a valid QR grid?
If we threshold this confidence, how much work do we save and how many real decodes do we lose?
```

## Documents in this first slice

- [01 Image Preprocessing](./01-image-preprocessing.md)
- [02 Scalar Views](./02-scalar-views.md)
- [03 Binary Views](./03-binary-views.md)
- [04 Finder Detection](./04-finder-detection.md)
- [05 Finder Evidence Construction](./05-finder-evidence-construction.md)

Later slices should add one document per downstream stage instead of extending these into a giant mixed document.
