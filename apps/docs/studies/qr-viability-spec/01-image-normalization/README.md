# 01 — Image Normalization

Image normalization converts browser `ImageData` into IronQR's canonical `SimpleImageData` artifact.

This stage starts **after** media decode. It normalizes browser `ImageData` into a stable 8-bit RGBA contract independent of whether the source was JPEG, PNG, WebP, HEIC, canvas, bitmap, video, or native/WASM decode.

## Responsibility

Stage 01 owns:

```text
final decoded-frame width/height/area validation
final buffer type and length validation
conversion from runtime ImageData formats into canonical 8-bit RGBA
canonical coordinate convention
safe integer RGBA pixel reads
L1 normalized-frame artifact semantics
```

Upstream/later-stage responsibilities:

```text
external media format support
HEIC/HEIF decoder selection
compressed source byte limits
video frame selection
temporal video tracking
scalar/binary derived view memoization
QR-specific detection
```

## Input

Input is the `ImageData` produced by stage 00.

`ImageData` from the browser platform contract is the stage boundary.

Current code still has a combined public entry point:

```ts
normalizeImageInput(input);
```

That function performs media decode when needed and then calls normalization. In this spec, those responsibilities are split:

```text
00 media decode → ImageData
01 image normalization → SimpleImageData
```

## Stage notes

| Note | Contract |
| --- | --- |
| [SimpleImageData](./simple-image-data.md) | Canonical width/height/`Uint8ClampedArray` RGBA artifact. |
| [Normalization policy](./normalization-policy.md) | `Uint8ClampedArray` adoption and HDR/float16 → SDR tone mapping. |
| [Pixel layout and access](./pixel-layout-and-access.md) | Row-major RGBA layout, coordinate convention, and safe pixel readers. |
| [Validation](./validation.md) | Dimension, area, buffer type, buffer length, and metrics. |
| [Alpha policy](./alpha-policy.md) | Preserve alpha in L1; scalar views composite over white. |
| [Runtime state boundary](./runtime-state-boundary.md) | `ViewBank` owns derived-view memoization. |
| [L1 artifact and cache boundary](./l1-artifact-cache.md) | Artifact metadata and cache-version bump policy. |

## Output

Stage 01 emits `SimpleImageData`:

```ts
interface SimpleImageData {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}
```

The emitted artifact satisfies:

```text
width > 0
height > 0
data instanceof Uint8ClampedArray
data.length === width × height × 4
pixel centers at integer coordinates
row-major RGBA layout
```
