# OKLab Views

```text
ok-l
ok-a
ok-b
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

## `ok-l`

```text
ok-l = clampByte(round(okL × 255))
```

This is perceptual lightness. It can provide a better brightness signal than Rec. 601 grayscale for some images.

## Signed chroma-axis views

The `a` and `b` channels are signed. Stage 02 emits one neutral-centered scalar view per signed chroma axis:

```text
OKLAB_CHROMA_BYTE_CENTER = 127.5
OKLAB_CHROMA_BYTE_GAIN = 180

ok-a = clampByte(round(OKLAB_CHROMA_BYTE_CENTER + okA × OKLAB_CHROMA_BYTE_GAIN))
ok-b = clampByte(round(OKLAB_CHROMA_BYTE_CENTER + okB × OKLAB_CHROMA_BYTE_GAIN))
```

Binary polarity in stage 03 handles opposite chroma directions:

```text
ok-a:otsu:normal
ok-a:otsu:inverted
ok-b:otsu:normal
ok-b:otsu:inverted
```

A QR may be darker in one chroma direction or the opposite. The scalar axis stores the signed chroma signal once; binary polarity chooses which direction counts as dark.
