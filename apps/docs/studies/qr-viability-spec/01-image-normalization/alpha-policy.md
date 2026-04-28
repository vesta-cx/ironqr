# Alpha Policy

Stage 01 preserves alpha as an 8-bit RGBA channel in `SimpleImageData`.

Scalar-view construction later composites RGB over white before producing grayscale/RGB/OKLab scalar values:

```text
alpha = A / 255
background = 1 - alpha
channel = (channel / 255) × alpha + background
```

Transparent pixels behave as if shown on white.

This is important for QR artwork with transparent backgrounds.
