# 03 — Binary Views

Binary views turn scalar values into black/white pixels.

This stage should answer:

```text
Which pixels are dark enough to count as QR ink?
Which threshold method produced that decision?
Should normal and inverted polarity both be tested?
```

## Current input

Input is one scalar view:

```ts
interface ScalarView {
  id: ScalarViewId;
  width: number;
  height: number;
  values: Uint8Array; // 0..255
}
```

## Current output artifacts

The current pipeline separates a polarity-free binary plane from polarity-aware binary views.

### Binary plane

```ts
interface BinaryPlane {
  readonly scalarViewId: ScalarViewId;
  readonly threshold: ThresholdMethod;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}
```

`data` stores bits as bytes:

```text
1 = dark
0 = light
```

### Binary view

```ts
interface BinaryView {
  readonly id: BinaryViewId;
  readonly scalarViewId: ScalarViewId;
  readonly threshold: ThresholdMethod;
  readonly polarity: BinaryPolarity;
  readonly width: number;
  readonly height: number;
  readonly plane: BinaryPlane;
  readonly binary: Uint8Array;
}
```

The binary view applies polarity on read:

```text
normal:   plane bit 1 means dark
inverted: plane bit 1 means light
```

So the same threshold plane can serve both dark-on-light and light-on-dark candidates.

## Current binary view id format

```text
scalarViewId : thresholdMethod : polarity
```

Examples:

```text
gray:otsu:normal
gray:otsu:inverted
oklab-l:sauvola:normal
b:hybrid:normal
```

## Current threshold methods

Current threshold methods:

```ts
otsu
sauvola
hybrid
```

Each answers a different question.

---

## Otsu thresholding

Otsu is a global threshold.

It asks:

```text
Can one cutoff split the whole image into dark and light groups?
```

The algorithm:

1. Build a histogram of scalar values `0..255`.
2. Try every threshold `t`.
3. Split pixels into:

```text
background: values <= t
foreground: values > t
```

4. Pick the threshold that maximizes between-class variance:

```text
variance = backgroundWeight × foregroundWeight × (meanBackground - meanForeground)^2
```

5. Mark pixels as:

```text
value > threshold → light bit 0
value <= threshold → dark bit 1
```

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

For each pixel, it computes local mean and local standard deviation in a window around the pixel.

Current default radius:

```text
radius = max(8, floor(min(width, height) / 8))
```

Current formula:

```text
threshold = mean × (1 + k × (deviation / dynamicRange - 1))
```

Current constants:

```text
k = 0.34
dynamicRange = 128
```

Then:

```text
value > threshold → light bit 0
value <= threshold → dark bit 1
```

The pipeline uses integral images so local sums are fast.

### Integral image

An integral image is a summed-area table. It lets us calculate the sum inside any rectangle in constant time.

For a rectangle:

```text
left, top, right, bottom
```

The sum is:

```text
sum(bottom,right)
- sum(top,right)
- sum(bottom,left)
+ sum(top,left)
```

The pipeline builds one table for values and one for squared values:

```text
sum
sumSq
```

Then:

```text
mean = localSum / area
variance = localSumSq / area - mean²
deviation = sqrt(variance)
```

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

Current default radius:

```text
radius = max(6, floor(min(width, height) / 10))
```

Current formula:

```text
global = otsuThreshold(values)
adaptive = mean - deviation × 0.08
threshold = global × 0.45 + adaptive × 0.55
```

Then:

```text
value > threshold → light bit 0
value <= threshold → dark bit 1
```

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

Instead of building two threshold planes, the scanner builds one plane and reads it with two polarities:

```ts
readBinaryBit(view, index)
```

For normal:

```text
plane 1 → dark
plane 0 → light
```

For inverted:

```text
plane 1 → light
plane 0 → dark
```

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

Current code does not expose all these values in the artifact, but the study should if we want to compare threshold behavior rigorously.

## Empirical questions

The realism study should measure:

| Question | Why |
| --- | --- |
| Which threshold methods produce valid decodes? | Prioritize useful view families. |
| Which threshold methods produce false positives or empty decodes? | Identify risky texture generators. |
| Which thresholds produce many finder triples but no decodes? | Work reduction target. |
| Do inverted views rescue positives or mostly add work? | Decide whether/when to include them. |
| Which thresholds produce high-realism but bad decode outcomes? | Improve realism scoring. |

## Cache boundary

This is L3 in the scanner artifact cache:

```text
L3 binary views
```

Bump L3 when:

- threshold formulas change,
- default threshold parameter constants change,
- polarity semantics change,
- binary bit encoding changes.
