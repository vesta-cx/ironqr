# OKLab Views

```text
oklab-l
oklab+a
oklab-a
oklab+b
oklab-b
```

OKLab is a perceptual color space. It separates:

| Channel | Rough meaning |
| --- | --- |
| `L` | lightness |
| `a` | green-red-ish axis |
| `b` | blue-yellow-ish axis |

The conversion path is documented in [OKLab Scalar View Math](./math-oklab.md):

```text
sRGB channel
→ linear RGB
→ LMS cone-like values
→ cube root nonlinearity
→ OKLab L/a/b
```

## `oklab-l`

```text
oklab-l = clampByte(L × 255)
```

This is perceptual lightness. It can provide a better brightness signal than Rec. 601 grayscale for some images.

## Signed color-axis views

The `a` and `b` channels can be positive or negative, but scalar views must be `0..255`. The scanner encodes both directions:

```text
oklab+a = clampByte(128 + a × 180)
oklab-a = clampByte(128 - a × 180)
oklab+b = clampByte(128 + b × 180)
oklab-b = clampByte(128 - b × 180)
```

A QR may be darker in one chroma direction or the opposite. Both signed directions are exposed to thresholding instead of assuming which side is foreground.
