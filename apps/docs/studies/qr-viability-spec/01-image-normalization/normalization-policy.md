# Normalization Policy

Stage 01 normalizes browser `ImageData` into this contract:

```text
row-major RGBA
8-bit unsigned clamped channels
4 bytes per pixel
pixel centers at integer coordinates
```

## Uint8ClampedArray input

For `Uint8ClampedArray` input with valid dimensions and buffer length:

```text
accept directly or copy according to ownership policy
```

## Float16Array / HDR input

Modern browser `ImageData` may use `Float16Array`, usually for HDR or wide-gamut canvas/image APIs.

Stage 01 converts HDR / float16 `ImageData` to SDR `SimpleImageData` with a color-managed tone-map, not a per-channel clamp.

`ImageData` exposes its color-space metadata, so stage 01 selects the tone-map from the input `ImageData` color space and pixel format.

MVP tone-mapping policy:

```text
read ImageData colorSpace and pixel format
use the matching color-space transform and transfer function
apply a deterministic luminance-based SDR tone map in stage 01
```

Normalization pipeline:

```text
read float16 RGBA channels
read ImageData colorSpace / pixel format
sanitize NaN / infinite / negative samples
linearize with the input color-space transfer function
convert input primaries to linear canonical SDR RGB
compute scene luminance Y from linear RGB
choose exposure / white point from robust frame luminance statistics
apply the color-space-specific luminance tone curve to map HDR Y into SDR Y
scale linear RGB by toneMappedY / max(Y, epsilon) to preserve chroma ratios
convert linear SDR RGB to the canonical SDR transfer function
clamp final RGB and alpha to 0..1
quantize to Uint8ClampedArray
```

The tone-map table defines one policy per supported `ImageData` color space:

```text
color-space identifier
input transfer function
linearization function
primary conversion matrix to canonical SDR RGB
luminance coefficients
robust white-point statistic
HDR shoulder curve
chroma-preservation policy
alpha conversion
rounding to Uint8ClampedArray
```

QR viability priority:

```text
preserve local light/dark contrast used by thresholding
preserve chroma ratios enough for RGB/OKLab scalar views
avoid hard clipping bright modules into flat white regions
produce deterministic bytes across runtimes for the same decoded ImageData
```

Stage 01 rejects float16 input when the `ImageData` color space or pixel format is outside the supported tone-map table.

Validate each supported color-space conversion with HDR/wide-gamut fixtures before making it a product guarantee.
