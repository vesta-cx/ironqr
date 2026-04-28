# OKLab Scalar View Math

OKLab views expose perceptual lightness and chroma signals that may preserve QR contrast better than plain grayscale.

This doc isolates the OKLab math from the scalar-view stage contract.

## Input

For each pixel, start with alpha-composited sRGB channels in `0..1`:

```text
sr, sg, sb
```

The current pipeline composites transparent pixels on white before OKLab conversion:

```text
alpha = A / 255
background = 1 - alpha
sr = (R / 255) × alpha + background
sg = (G / 255) × alpha + background
sb = (B / 255) × alpha + background
```

## Step 1: sRGB to linear RGB

sRGB values are gamma encoded. Convert each channel to linear light:

```text
if value <= 0.04045:
  linear = value / 12.92
else:
  linear = ((value + 0.055) / 1.055) ^ 2.4
```

Output:

```text
lr, lg, lb
```

## Step 2: linear RGB to cone-like LMS values

The scanner uses OKLab's matrix constants:

```text
Lcone = cbrt(0.4122214708 × lr + 0.5363325363 × lg + 0.0514459929 × lb)
Mcone = cbrt(0.2119034982 × lr + 0.6806995451 × lg + 0.1073969566 × lb)
Scone = cbrt(0.0883024619 × lr + 0.2817188376 × lg + 0.6299787005 × lb)
```

The cube root is part of OKLab's perceptual nonlinearity.

## Step 3: LMS to OKLab

```text
okL =  0.2104542553 × Lcone + 0.7936177850 × Mcone - 0.0040720468 × Scone
okA =  1.9779984951 × Lcone - 2.4285922050 × Mcone + 0.4505937099 × Scone
okB =  0.0259040371 × Lcone + 0.7827717662 × Mcone - 0.8086757660 × Scone
```

Interpretation:

| Plane | Rough meaning               |
| ----- | --------------------------- |
| `okL` | perceptual lightness        |
| `okA` | green/red-ish chroma axis   |
| `okB` | blue/yellow-ish chroma axis |

## Step 4: encode to 8-bit scalar views

The pipeline stores scalar views as `Uint8Array`, so OKLab channels are encoded to bytes.

```text
OKLAB_CHROMA_BYTE_CENTER = 127.5
OKLAB_CHROMA_BYTE_GAIN = 180

ok-l = clampByte(round(okL × 255))
ok-a = clampByte(round(OKLAB_CHROMA_BYTE_CENTER + okA × OKLAB_CHROMA_BYTE_GAIN))
ok-b = clampByte(round(OKLAB_CHROMA_BYTE_CENTER + okB × OKLAB_CHROMA_BYTE_GAIN))
```

`ok-a` and `ok-b` are neutral-centered signed chroma-axis views. The `180` gain spreads practical OKLab chroma values across more of the byte range for thresholding.

## Chroma direction

Chroma contrast has direction: a QR may be foreground-red/background-green or foreground-green/background-red. Those are opposite signs on the `a` axis.

Stage 02 emits one scalar view per signed chroma axis. Stage 03 binary polarity handles direction:

```text
ok-a:otsu:normal
ok-a:otsu:inverted
ok-b:otsu:normal
ok-b:otsu:inverted
```

The symmetric center `127.5` makes binary inversion the canonical opposite-direction view instead of materializing separate `+` and `-` scalar views.

## Validation metrics

- Successful decode provenance by OKLab scalar view and binary polarity.
- Empty-payload false positives by OKLab scalar view and binary polarity.
- Positives rescued by chroma-axis views after grayscale miss.
- False-positive and success balance across normal/inverted polarity.
