# 02 — Scalar Views

Scalar views turn RGBA image pixels into one grayscale-like number per pixel.

A scalar view is not black/white yet. It is a single 8-bit view:

```text
0..255 value per pixel
```

This stage defines the scalar image signals exposed before thresholding and detector work.

## Input

Input is the `SimpleImageData` emitted by stage 01:

```ts
interface SimpleImageData {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}
```

The input pixels are canonical SDR, row-major RGBA bytes. Runtime-specific `ImageData` fields and HDR/float16 data have already been normalized by stage 01.

## Output view

Scalar views are runtime-derived views owned by `ViewBank`. Persistent cache artifacts may store the same bytes as L2 scalar-view artifacts.

```ts
interface ScalarView {
  readonly id: ScalarViewId;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}
```

Meaning:

| Field             | Meaning                                             |
| ----------------- | --------------------------------------------------- |
| `id`              | Stable scalar view id, such as `gray` or `oklab-l`. |
| `width`, `height` | Same dimensions as input image.                     |
| `data`            | One byte per pixel.                                 |

Current implementation may still call the byte array `values`. This spec uses `data` consistently with `SimpleImageData` and later view types.

View grouping belongs in static view registry metadata, keyed by `ScalarViewId`, rather than on every `ScalarView` object.

## Current scalar view ids

Current scalar views:

```text
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

## Group 1: grayscale

```text
gray
```

Formula after alpha compositing on white, using Rec. 601 luma coefficients in gamma-encoded canonical SDR RGB byte space:

```text
gray = round(0.299 × R8 + 0.587 × G8 + 0.114 × B8)
```

Where `R8`, `G8`, and `B8` are the 0..255 alpha-composited SDR RGB channel values from `SimpleImageData`.

Equivalent normalized form:

```text
gray = round((0.299 × R' + 0.587 × G' + 0.114 × B') × 255)
```

Where `R'`, `G'`, and `B'` are gamma-encoded canonical SDR RGB channels normalized to `0..1`, not linear-light RGB.

This is Rec. 601-style luma (`Y'`), not linear luminance (`Y`).

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

| Plane | Rough meaning        |
| ----- | -------------------- |
| `L`   | lightness            |
| `a`   | green-red-ish axis   |
| `b`   | blue-yellow-ish axis |

The current conversion path is documented separately in [OKLab Scalar View Math](./math-oklab.md):

```text
sRGB channel
→ linear RGB
→ LMS cone-like values
→ cube root nonlinearity
→ OKLab L/a/b
```

### `oklab-l`

```text
oklab-l = clampByte(L × 255)
```

This is perceptual lightness. It is often a better brightness signal than simple grayscale.

### Signed color-axis views

The `a` and `b` channels can be positive or negative, but scalar views must be `0..255`. The scanner encodes both directions:

```text
oklab+a = clampByte(128 + a × 180)
oklab-a = clampByte(128 - a × 180)
oklab+b = clampByte(128 + b × 180)
oklab-b = clampByte(128 - b × 180)
```

Both signs rationale

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

The scanner has a prioritized proposal-view subset derived from a prior exhaustive view report. These are binary view ids, but they imply scalar view ids that have historically helped.

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

## Artifact metadata

For math-based QR viability, scalar views remain simple, while reports preserve contribution accounting:

```ts
interface ScalarViewArtifact {
  readonly id: ScalarViewId;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  readonly formula: string;
}
```

The formula metadata helps compare behavior across view changes.

## Validation metrics

The implementation and reports must eventually capture:

| Metric                                                 | Purpose                                                           |
| ------------------------------------------------------ | ----------------------------------------------------------------- |
| Finder evidence reaching valid decode by scalar view   | Avoid spending detector work on low-value views.                  |
| False-positive empty decodes by scalar view            | Identify risky channels.                                          |
| Positives rescued by chroma views after grayscale miss | Justify chroma-view cost.                                         |
| Proposal volume without valid decode by scalar view    | Identify views for lower priority or budget caps.                 |
| View usefulness by corpus family                       | Generated/stylized/photographic QR may need different view order. |

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
