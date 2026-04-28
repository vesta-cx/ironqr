# 02 — Scalar Views

Scalar views turn RGBA image pixels into one grayscale-like number per pixel.

A scalar view is not black/white yet. It is a single 8-bit plane:

```text
0..255 value per pixel
```

This stage should answer:

```text
Which image signals do we expose before thresholding?
Why these color channels?
Which views actually contribute finder evidence and valid decodes?
```

## Current input

Input is the normalized image from stage 01:

```ts
interface NormalizedImage {
  width: number;
  height: number;
  rgbaPixels: Uint8ClampedArray;
}
```

## Current output artifact

Current scalar view shape:

```ts
interface ScalarView {
  readonly id: ScalarViewId;
  readonly width: number;
  readonly height: number;
  readonly values: Uint8Array;
  readonly family: 'rgb' | 'oklab' | 'derived';
}
```

Meaning:

| Field | Meaning |
| --- | --- |
| `id` | Stable scalar view id, such as `gray` or `oklab-l`. |
| `width`, `height` | Same dimensions as input image. |
| `values` | One byte per pixel. |
| `family` | Broad view family used by decode-neighborhood logic. |

## Current scalar view ids

Current scalar views:

```ts
gray
r
g
b
oklab-l
oklab+a
oklab-a
oklab+b
oklab-b
```

They fall into three groups.

## Group 1: derived grayscale

```text
gray
```

Formula after alpha compositing on white:

```text
gray = round((0.299 × r + 0.587 × g + 0.114 × b) × 255)
```

Where `r`, `g`, and `b` are normalized to `0..1` first.

Why use it:

- Most QR codes are dark-on-light contrast.
- Grayscale is cheap.
- It is the baseline signal users expect.

Why it is not enough:

- Colored QR codes may hide contrast in grayscale.
- Background color can reduce luminance contrast.
- Stylized assets may have useful chroma contrast but weak brightness contrast.

## Group 2: RGB channel views

```text
r
g
b
```

Each is just one alpha-composited RGB channel scaled to `0..255`:

```text
rView = round(r × 255)
gView = round(g × 255)
bView = round(b × 255)
```

Why use them:

- Some QR-like contrast appears strongly in one color channel.
- Blue/yellow or red/cyan artwork can be weak in grayscale but strong in one channel.
- They are cheap to compute.

## Group 3: OKLab views

```text
oklab-l
oklab+a
oklab-a
oklab+b
oklab-b
```

OKLab is a perceptual color space. It tries to separate:

| Plane | Rough meaning |
| --- | --- |
| `L` | lightness |
| `a` | green-red-ish axis |
| `b` | blue-yellow-ish axis |

The current conversion path:

```text
sRGB channel
→ linear RGB
→ LMS cone-like values
→ cube root nonlinearity
→ OKLab L/a/b
```

The current formulas use the standard OKLab matrix constants.

### `oklab-l`

```text
oklab-l = clampByte(L × 255)
```

This is perceptual lightness. It is often a better brightness signal than simple grayscale.

### Signed color-axis views

The `a` and `b` planes can be positive or negative, but scalar views must be `0..255`. The scanner encodes both directions:

```text
oklab+a = clampByte(128 + a × 180)
oklab-a = clampByte(128 - a × 180)
oklab+b = clampByte(128 + b × 180)
oklab-b = clampByte(128 - b × 180)
```

Why both signs?

A QR may be darker in one chroma direction or the opposite. Instead of assuming which side is foreground, both signed directions are exposed to thresholding.

## Why this scalar selection exists

The scanner is trying to catch QR contrast across:

```text
brightness
red channel
green channel
blue channel
perceptual lightness
red/green chroma
blue/yellow chroma
```

The goal is not to make every scalar view equally valuable. The goal is to create enough independent views that real finder patterns show up in at least one of them.

## Current proposal-view subset

The scanner has a prioritized proposal-view subset derived from a prior exhaustive view study. These are binary view ids, but they imply scalar families that have historically helped.

Current first entries:

```text
gray:otsu:normal
oklab-l:hybrid:normal
gray:sauvola:normal
oklab-l:sauvola:normal
oklab-l:otsu:normal
b:hybrid:normal
...
```

This means `gray`, `oklab-l`, and `b` have been strong early contributors in previous empirical runs.

## Target realism artifact

For math-based realism, scalar views should remain simple, but reports should preserve contribution accounting:

```ts
interface ScalarViewArtifact {
  readonly id: ScalarViewId;
  readonly width: number;
  readonly height: number;
  readonly values: Uint8Array;
  readonly family: 'derived' | 'rgb' | 'oklab';
  readonly formula: string;
}
```

The formula metadata helps when comparing studies across view changes.

## Empirical questions

The realism study should eventually answer:

| Question | Why |
| --- | --- |
| Which scalar views produce finder evidence that reaches valid decode? | Avoid spending detector work on low-value views. |
| Which scalar views produce false-positive empty decodes? | Identify risky channels. |
| Do chroma views rescue positives missed by grayscale? | Justifies their cost. |
| Do some views produce many proposals but no valid decode? | Candidate for lower priority or budget cap. |
| Does view usefulness differ by corpus family? | Generated/stylized/photographic QR may need different view order. |

## Cache boundary

This is L2 in the scanner artifact cache:

```text
L2 scalar views
```

Bump L2 when:

- scalar view list changes,
- formulas change,
- alpha-composite policy changes in a way that affects scalar values,
- OKLab encoding scale or sign convention changes.
