# 00 — Media Decode

Media decode turns an external media source into browser `ImageData`.

This stage is intentionally separate from image normalization:

```text
00 media decode
  external source → ImageData

01 image normalization
  ImageData → SimpleImageData with Uint8ClampedArray RGBA
```

Stage 00 is runtime- and format-specific. Stage 01 is IronQR's platform-independent pixel contract.

## Responsibility

Stage 00 owns:

```text
external source format handling
decoder/backend selection
compressed source byte limits
pre-decode metadata validation when dimensions are available
browser/runtime/native media decode behavior
video frame extraction policy
animated image frame policy
EXIF/orientation policy
color-profile/rasterization policy
decode errors before pixel normalization
```

Downstream responsibilities:

```text
canonical 8-bit RGBA conversion
final decoded-frame width/height/area validation
final buffer type and length validation
canonical coordinate convention
safe RGBA pixel reads
scalar/binary derived views
QR-specific detection
```

## Input

Stage 00 accepts external media sources, including browser-shaped sources and future native/WASM sources.

Current public browser-style scan input includes:

```text
ImageData pixel buffers
ImageBitmap-like sources
Blob/File-like compressed sources
Canvas-like sources
VideoFrame-like sources
```

Target source support:

```text
all common still-image formats supported by the active browser/runtime
plus explicit HEIC/HEIF support for iPhone uploads via platform decode or existing decoder binding
```

The product target is broad practical still-image support: common runtime-supported formats, explicit HEIC/HEIF support for iPhone uploads, and clear unsupported-format errors for obscure, unsafe, encrypted, malformed, multi-page, or unavailable decoder cases.

## Output

Stage 00 outputs browser `ImageData`.

Notes:

- Classic browser `ImageData.data` is `Uint8ClampedArray`.
- Modern HDR / wide-gamut `ImageData` may use a float16 pixel format in runtimes that expose it.
- Stage 01 converts supported pixel formats to canonical `Uint8ClampedArray` RGBA and rejects unsupported decoded pixel formats.

Stage 01 normalizes `ImageData` into `SimpleImageData` using only the decoded frame contract, independent of whether the pixels came from JPEG, PNG, WebP, HEIC, a canvas, or a video frame.

## Current browser decode path

If the input is already `ImageData`, decoding is skipped:

```text
ImageData input
→ stage 01 normalization
```

If the input is a compressed/browser source, the current browser path is:

```text
input
→ preflight source validation
→ createImageBitmap(input) when needed
→ draw bitmap to OffscreenCanvas
→ getImageData(0, 0, width, height)
→ stage 01 normalization
```

This means the browser/runtime currently owns much of the media interpretation:

```text
JPEG/PNG/WebP decode
browser-supported formats
EXIF orientation behavior
color profile conversion/rasterization
image smoothing/raster details from drawImage/getImageData
```

## Format support policy

MVP format support uses [Tier 1 — Platform Decode](./tier-1-platform-decode.md).

```text
source
→ Tier 1 platform decode
→ ImageData or actionable media-decode error
```

Post-MVP branches remain documented for the target architecture:

| Tier | Branch | Status | Contract |
| --- | --- | --- | --- |
| 1 | [Platform decode](./tier-1-platform-decode.md) | MVP | Use browser/runtime/native decode paths when available. |
| 2 | [Existing format libraries](./tier-2-existing-format-libraries.md) | Post-MVP | Use mature browser/WASM/Node/native bindings for widely used formats. |
| 3 | [IronQR-owned decoder](./tier-3-ironqr-owned-decoder.md) | Post-MVP | Add IronQR decoder code only when platform decode and existing libraries cannot satisfy a required format. |
| 4 | [Actionable rejection](./tier-4-actionable-rejection.md) | MVP fallback | Return a clear unsupported-format error with caller guidance. |

MVP decoder policy:

```text
try platform decode
else reject with actionable unsupported-format error
```

Post-MVP decoder policy:

```text
try platform decode if supported
else detect the format and use an existing decoder binding
else use an IronQR-owned decoder when required and no suitable implementation exists
else reject with actionable unsupported-format error
```

Explicit post-MVP target:

```text
HEIC / HEIF for iPhone uploads
```

HEIC/HEIF support follows the same branch order: platform decode first, existing decoder binding second, IronQR-owned decoder only if required.

## Format detection

Use layered detection from multiple signals:

```text
declared MIME type
file extension
magic bytes / file signature
runtime decode probe
```

HEIC/HEIF are ISO BMFF-family files. Detection often uses the `ftyp` box and brands such as:

```text
heic
heix
hevc
hevx
mif1
msf1
```

## Pre-decode metadata validation

Many source types expose dimensions before or during decode:

| Source kind | Dimension metadata |
| --- | --- |
| `ImageData` | `width`, `height` |
| `ImageBitmap` | `width`, `height` |
| `Canvas` | `width`, `height` |
| `VideoFrame` | `displayWidth` / `displayHeight` or `codedWidth` / `codedHeight` |
| `Blob` / `File` | byte size; dimensions require header parse or decode |
| encoded PNG/JPEG/WebP/HEIC bytes | dimensions often exist in headers/boxes; current browser path gets them through decode unless a header parser is added |

Stage 00 must reject impossible or over-budget dimensions as early as metadata permits.

Policy:

```text
if dimensions are available before decode, validate them in stage 00
always validate the decoded frame again in stage 01
```

Why validate twice?

- Metadata can be absent.
- Metadata can be wrong or malicious.
- Decode can apply orientation/transforms that change displayed dimensions.
- Different runtimes may expose coded vs display dimensions differently.
- Stage 01 is the final trust boundary for actual decoded pixels.

## Source size limits

Compressed source byte limits are stage 00 policy.

Current browser preflight ties source byte cap to the decoded area budget:

```ts
MAX_IMAGE_SOURCE_BYTES = MAX_IMAGE_PIXELS * 4;
```

That is a safety cap before bitmap decode. Decoded pixel memory is governed by stage 01 width/height/area validation.

Target policy:

```text
compressed-source byte limits are stage 00 policy
metadata dimension preflight is stage 00 policy when dimensions are available
decoded width/height/area validation is stage 01 policy and always runs
```

A compressed JPEG or HEIC can be small while decoding to a huge frame, so stage 01 area validation always follows byte-size validation.

## Video and animation policy

Video and animated images need explicit frame-selection policy.

Target behavior:

```text
single VideoFrame scan = decode exactly that frame
stream scan = caller/session provides frames over time
animated image scan = first frame by default unless explicit frame selection exists
```

Future scanner-session design owns temporal tracking.

## Color, HDR, and orientation policy

Stage 00 may produce runtime-specific `ImageData`:

```text
8-bit sRGB-like RGBA
Display-P3 data
float16 HDR data
runtime-oriented pixels
non-oriented pixels, depending on decoder
```

Stage 00 must record decode metadata when the runtime exposes it.

Stage 01 owns conversion to IronQR's canonical 8-bit RGBA `SimpleImageData`.

Until a full HDR policy exists:

```text
Float16 / HDR ImageData is allowed as a stage-00 decoded frame shape
stage 01 must explicitly convert it with documented policy or reject it
```

Handle `Float16Array` through explicit HDR conversion or unsupported-format rejection.

## Errors

Stage 00 errors are about failing to obtain a decoded frame:

```text
unsupported source kind
unsupported image format
source byte limit exceeded
metadata dimensions over budget
missing browser decode APIs
decode failure
canvas/context failure
decoder binding failure
```

Stage 01 errors are about failing to normalize the decoded frame:

```text
bad decoded dimensions
decoded area too large
unsupported decoded pixel format
bad buffer type
bad buffer length
unsupported color/HDR conversion policy
```

## Validation metrics

| Metric | Purpose |
| --- | --- |
| Format coverage by runtime | Verify browser/native/WASM support promises. |
| HEIC/HEIF iPhone fixture coverage | Ensure iPhone uploads work. |
| Metadata preflight rejection count | Prove oversized inputs fail before expensive decode when possible. |
| Decode-output pixel format distribution | Track `Uint8ClampedArray` vs `Float16Array` / HDR cases. |
| EXIF/orientation fixture outcomes | Prevent platform-specific rotation bugs. |
| Color-profile fixture outcomes | Prevent platform-specific color/threshold behavior. |
| Compressed-byte cap failures | Validate source-size safety policy. |

## Cache boundary

The persisted artifact boundary starts after stage 01 normalization at L1. Stage 00 may gain an L0 artifact only when decoder comparisons need persisted decoded-frame outputs.

If future decoder comparisons need persisted artifacts, add a separate pre-L1 cache identity:

```text
L0 decoded media frame
```

Bump L0 when media decode policy changes, such as orientation handling, color profile conversion, animated-frame selection, HEIC/HEIF decoder selection, or decoder backend.
