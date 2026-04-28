# 03 — Binary Views

Binary views turn scalar values into black/white pixels.

This stage defines the threshold method and polarity semantics that convert scalar values into QR-ink decisions.

Every scalar-view/threshold-method pair exposes both polarities:

```text
normal
inverted
```

Both polarities are tested because QR artwork can be dark-on-light or light-on-dark.

## Input

Input is one scalar view:

```ts
interface ScalarView {
  readonly id: ScalarViewId;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array; // 0..255
}
```

## Output views

A binary view is a materialized black/white view.

```ts
interface BinaryView {
  readonly id: BinaryViewId;
  readonly scalarViewId: ScalarViewId;
  readonly threshold: ThresholdMethod;
  readonly polarity: BinaryPolarity;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}
```

`data` stores QR-ink decisions as bytes:

```text
1 = dark / QR ink
0 = light / background
```

Both polarities are materialized for fast detector reads:

```text
normal.data[index] = thresholdResult[index]
inverted.data[index] = 1 - normal.data[index]
```

The inverted view is derived from the already-materialized normal binary view, not from `SimpleImageData` and not by re-running thresholding.

## Current binary view id format

```text
scalarViewId : thresholdMethod : polarity
```

Examples:

```text
gray:otsu:normal
gray:otsu:inverted
ok-l:sauvola:normal
ok-a:otsu:inverted
b:hybrid:normal
```

## Current threshold methods

Current threshold methods:

```ts
otsu
sauvola
hybrid
```

Each has a different responsibility.

---

## Otsu thresholding

Otsu is a global threshold.

It asks:

```text
Can one cutoff split the whole image into dark and light groups?
```

Detailed math lives in [Otsu Threshold Math](./math-otsu.md).

Why use it:

- Very cheap.
- Works well when the whole image has clear global contrast.
- Good first-pass signal.

Why it fails:

- Uneven lighting.
- Shadows.
- Local glare.
- QR over textured backgrounds.

---

## Sauvola thresholding

Sauvola is a local adaptive threshold.

It asks:

```text
Compared to its neighborhood, is this pixel dark?
```

Detailed math lives in [Sauvola Threshold Math](./math-sauvola.md).

Why use Sauvola:

- Handles local lighting changes.
- Often better for photographed QR codes.
- Can recover finders that global threshold misses.

Why it can be risky:

- It may turn texture into QR-like black/white structure.
- It can create many false finder candidates on busy images.

---

## Hybrid thresholding

Hybrid blends global and local threshold ideas.

It asks:

```text
Can global contrast anchor the threshold while local statistics adjust it?
```

Detailed math lives in [Hybrid Threshold Math](./math-hybrid.md).

Why use it:

- Otsu is stable but too global.
- Sauvola is local but can be noisy.
- Hybrid is a rescue family for hard photographed assets.

---

## Polarity

QR codes are usually dark modules on light background, but images may contain:

```text
normal QR:   black code on white background
inverted QR: light code on dark background
```

Normal polarity is threshold output. Inverted polarity is materialized from normal polarity:

```text
normal.data[index] = thresholdResult[index]
inverted.data[index] = 1 - normal.data[index]
```

Detector hot loops read `view.data[index]` directly. They do not dispatch through polarity-aware getters.

## Target realism artifact

For math-based realism, binary views should include enough metadata for empirical accounting:

```ts
interface BinaryViewArtifact {
  readonly id: BinaryViewId;
  readonly scalarViewId: ScalarViewId;
  readonly threshold: ThresholdMethod;
  readonly polarity: BinaryPolarity;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  readonly thresholdParameters: Record<string, number>;
}
```

Useful parameters:

```text
otsu threshold value
sauvola radius/k/dynamicRange
hybrid radius/global/adaptive weights
```

Current code does not expose all these values in the artifact, but the spec requires them before threshold behavior can be compared rigorously.

## Validation metrics

The implementation and reports must measure:

| Metric | Purpose |
| --- | --- |
| Which threshold methods produce valid decodes? | Prioritize useful view families. |
| Which threshold methods produce false positives or empty decodes? | Identify risky texture generators. |
| Which thresholds produce many finder triples but no decodes? | Work reduction target. |
| Do inverted views rescue positives or mostly add work? | Decide whether/when to include them. |
| Which thresholds produce high-realism but bad decode outcomes? | Improve realism scoring. |

## Study cache note

Runtime scanning owns binary views through production `ViewBank` memoization. Benchmark/study tooling may additionally write this stage to disk as:

```text
L3 binary views
```

Bump the study L3 cache version when:

- threshold formulas change,
- default threshold parameter constants change,
- polarity semantics change,
- binary bit encoding changes.
