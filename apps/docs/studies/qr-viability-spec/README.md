# Math-Based QR Viability Pipeline Spec

This directory is the working spec for IronQR's math-based QR realism pipeline.

It defines the pipeline as a sequence of small, specified stages. Each stage owns one responsibility, one artifact contract, and one set of validation metrics.

The goal is to stop treating “QR-looking” signals as one blurry score. Each stage should produce a concrete artifact that later stages can measure, compare, and use for ranking or filtering.

## Spec status

This is a living implementation spec, not just explanatory prose.

Use it to decide:

```text
what artifact each stage owns
which data is canonical vs derived
where runtime memoization is allowed
which math/residuals must be measured before production policy changes
```

When code and this spec disagree, either:

1. update the code to match the spec, or
2. update the spec with evidence explaining why the old plan was wrong.

Do not let them silently drift.

## Pipeline shape

```text
00 media decode
→ 01 image normalization
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

## Artifact and state rules

### Canonical artifacts are pure

A stage artifact should contain the semantic output of that stage, not hidden runtime state.

For example, normalized image data is:

```ts
interface NormalizedImage {
  readonly width: number;
  readonly height: number;
  readonly rgbaPixels: Uint8ClampedArray;
}
```

It must not own derived scalar/binary view caches.

### Runtime memoization belongs to execution context

Temporary derived-view reuse belongs in a per-scan execution object, such as:

```text
ViewBank
```

not inside canonical artifacts.

The intended separation is:

```text
SimpleImageData
  pure decoded pixels

ViewBank
  per-scan temporary memoization of scalar views, binary views, and derived view backing stores

StudyArtifactCache
  persistent per-layer/per-asset cache for benchmark/study runs only
```

This keeps parallel execution and async work easier to reason about:

```text
one image/frame → one ViewBank → garbage-collected after scan
many assets/workers → many independent contexts
cross-run study reuse → explicit study artifact cache, not hidden object mutation
```

### Disk-backed layer caches are study-only

Runtime scanner code uses canonical artifacts and per-scan `ViewBank` memoization in production. The study-only part is writing tiered/layered artifacts to disk and using numeric cache versions to invalidate those persisted files.

Do not blur these:

| Concept | Lifetime | Owner | Example |
| --- | --- | --- | --- |
| Canonical artifact | stage output | pipeline | `SimpleImageData` |
| Runtime memoization | one scan/frame | `ViewBank` | cached `gray` view |
| Disk-backed study artifact cache | across benchmark/study runs | study tooling | L1-L8 files + version numbers |

## Directory convention

Each numbered stage is its own subdirectory:

```text
NN-stage-name/
  README.md                  # stage contract and overview
  math-*.md                  # focused math derivations
  why-*.md                   # focused justification docs
  artifact-*.md              # artifact schemas
  validation.md              # validation metrics, fixtures, and acceptance criteria
```

Keep docs small and responsible for one idea. If a section starts explaining a separate algorithm, split it into a sibling file and link it from the stage README.

## Rule for every stage README

Each stage README should document:

1. **Input**: what data it receives.
2. **Output artifact**: what it must emit.
3. **Canonical vs runtime state**: what belongs in the artifact and what belongs in `ViewBank`.
4. **Math / algorithm**: short overview only; detailed derivations belong in `math-*.md`.
5. **Why this signal exists**: what failure mode it helps.
6. **Validation metrics**: what evidence must be collected to prove the stage works.
7. **Study cache note**: whether benchmark/study tooling may persist this stage separately.

## Current-vs-target language

These docs intentionally distinguish:

- **Current pipeline**: what the code mostly does today.
- **Target realism pipeline**: the math-based artifacts we want to evolve toward.

The current pipeline already has good pieces: normalized frames, scalar views, binary views, row-scan/matcher detectors, proposal frontiers, cluster frontiers, and decode-confirmation reports.

The target pipeline adds richer finder geometry and shared-grid residuals so we can ask:

```text
Can this finder evidence mathematically explain a valid QR grid?
If we threshold this confidence, how much work do we save and how many real decodes do we lose?
```

## Spec invariants

These rules hold unless implementation evidence proves a better contract:

1. **Validate dimensions as early as possible and again at normalization.** Stage 00 should reject over-budget metadata dimensions when available; stage 01 must validate the actual decoded RGBA frame.
2. **Normalized pixels are decoded pixels only.** Derived views do not belong inside `SimpleImageData`.
3. **Coordinates for geometry are continuous.** Finder/module centers and edges may be fractional image-space points.
4. **Rounding is a sampling concern.** Do not round during geometry fitting; only sample/interpolate at image-read boundaries.
5. **Finder evidence starts as a seed.** Center/module-size evidence is not enough for final realism decisions.
6. **Ranking precedes filtering.** Hard rejection needs threshold sweeps proving work saved with no unacceptable decode loss.
7. **Decode confirmation is the accuracy guard.** Realism scores are useful only if they preserve valid decoded positives and control false positives.
8. **False-positive accounting must distinguish raw decoder success from accepted scan result.** Empty-payload decodes should stay visible as diagnostics even if rejected from public results.

## Current stage docs

- [00 Media Decode](./00-media-decode/README.md)
- [01 Image Normalization](./01-image-normalization/README.md)
- [02 Scalar Views](./02-scalar-views/README.md)
- [03 Binary Views](./03-binary-views/README.md)
- [04 Finder Detection](./04-finder-detection/README.md)
- [05 Finder Evidence Construction](./05-finder-evidence-construction/README.md)

Later slices should add one subdirectory per downstream stage instead of extending these into a giant mixed document.
