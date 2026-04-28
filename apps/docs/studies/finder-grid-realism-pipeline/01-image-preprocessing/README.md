# 01 — Image Preprocessing

Image preprocessing turns an input image into the scanner's canonical pixel buffer.

This stage should answer:

```text
What exact pixels are later stages allowed to read?
What coordinate system do those pixels live in?
What validation happened before expensive scanner work starts?
```

## Current pipeline input

The public scanner accepts browser-style image sources, including already pixel-backed `ImageData`-like inputs and browser image objects that can be drawn to a canvas.

Current core entry point:

```ts
normalizeImageInput(input);
```

For already decoded data, the scanner uses:

```ts
createNormalizedImage(imageData);
```

## Current output artifact

The current artifact is:

```ts
interface NormalizedImage {
  readonly width: number;
  readonly height: number;
  readonly rgbaPixels: Uint8ClampedArray;
  readonly derivedViews: DerivedViewCache;
}
```

Meaning:

| Field          | Meaning                                                                     |
| -------------- | --------------------------------------------------------------------------- |
| `width`        | Image width in pixels.                                                      |
| `height`       | Image height in pixels.                                                     |
| `rgbaPixels`   | Flat RGBA pixel buffer, 4 bytes per pixel.                                  |
| `derivedViews` | Lazy cache for scalar views, binary views, binary planes, and OKLab planes. |

The RGBA layout is:

```text
pixel 0: R, G, B, A
pixel 1: R, G, B, A
pixel 2: R, G, B, A
...
```

For pixel `(x, y)`, the base offset is:

```text
index = y × width + x
base = index × 4
r = rgbaPixels[base + 0]
g = rgbaPixels[base + 1]
b = rgbaPixels[base + 2]
a = rgbaPixels[base + 3]
```

## Coordinate convention

The scanner's image-space coordinate convention should be documented as:

```text
integer pixel coordinates refer to pixel centers
pixel (x=10, y=20) has center at image point (10, 20)
continuous image points may use fractional coordinates
```

So these are valid continuous image-space points:

```text
(10, 20)
(10.5, 20)
(10.25, 20.75)
```

This matters because later finder geometry should store subpixel module centers and module edges. Geometry fitting must not round these points. Rounding or interpolation only belongs at the image-sampling boundary.

## Current validation

Validation happens at the trust boundary.

Current limits:

```ts
MAX_IMAGE_DIMENSION = 8192;
MAX_IMAGE_PIXELS = 24_000_000;
MAX_IMAGE_SOURCE_BYTES = MAX_IMAGE_PIXELS * 4;
```

The scanner rejects:

- non-safe-integer dimensions,
- zero or negative dimensions,
- width/height above max side length,
- total area above max pixel count,
- `ImageData` buffers that are not `Uint8ClampedArray`,
- RGBA buffers with wrong length.

This means downstream stages may assume:

```text
width > 0
height > 0
rgbaPixels.length = width × height × 4
```

## Browser decode path

If the input is not already `ImageData`, the browser path is:

```text
input
→ createImageBitmap(input) when needed
→ draw bitmap to OffscreenCanvas
→ getImageData(0, 0, width, height)
→ createNormalizedImage(...)
```

This makes the browser/runtime responsible for compressed image decoding, EXIF handling, color-management behavior, and pixel rasterization.

## Alpha handling

The normalized image stores the RGBA pixels as provided by `ImageData`.

Scalar-view construction later composites RGB over white before producing grayscale/RGB/OKLab scalar values:

```text
alpha = A / 255
background = 1 - alpha
channel = (channel / 255) × alpha + background
```

So transparent pixels behave as if shown on white.

This is important for QR artwork with transparent backgrounds.

## Target realism artifact

For math-based realism, this stage should remain simple and stable:

```ts
interface NormalizedFrameArtifact {
  readonly width: number;
  readonly height: number;
  readonly rgbaPixels: Uint8ClampedArray;
  readonly coordinateConvention: "pixel-centers-at-integers";
  readonly alphaCompositePolicy: "views-composite-on-white";
}
```

The key addition is not more data; it is precise metadata about coordinate and alpha policy so downstream geometry has no ambiguity.

## Empirical questions

This stage itself is not a QR signal, but it affects every later signal. Studies should track:

| Question                                                          | Why                                         |
| ----------------------------------------------------------------- | ------------------------------------------- |
| Do transparent assets behave differently after white compositing? | QR artwork may rely on transparency.        |
| Do very large images dominate materialization time?               | Cache and budget planning.                  |
| Are decode/finder failures correlated with source dimensions?     | Very small modules can become unresolvable. |

## Cache boundary

This is L1 in the scanner artifact cache:

```text
L1 normalized frame
```

Bump the L1 cache version only when the meaning of normalized pixels changes, such as:

- different alpha-composite policy,
- different browser decode/rasterization path in benchmark tooling,
- different dimension validation semantics that affect accepted assets.
