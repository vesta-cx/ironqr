# Pixel Layout and Access

## RGBA layout

The RGBA layout is row-major:

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
r = data[base + 0]
g = data[base + 1]
b = data[base + 2]
a = data[base + 3]
```

`width` is the row length. When `x` reaches `width`, the next pixel is the start of the next row.

## Shared RGBA pixel reader

The spec exposes a safe coordinate helper for non-hot code, tests, and documentation. This helper encodes the row-major RGBA layout in one place.

```ts
interface RgbaPixel {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const isPixelInBounds = (
  image: SimpleImageData,
  x: number,
  y: number,
): boolean =>
  Number.isInteger(x) &&
  Number.isInteger(y) &&
  x >= 0 &&
  y >= 0 &&
  x < image.width &&
  y < image.height;

const rgbaPixelOffset = (
  image: SimpleImageData,
  x: number,
  y: number,
): number => {
  if (!isPixelInBounds(image, x, y)) {
    throw new RangeError(
      `Pixel coordinate (${x}, ${y}) is outside ${image.width}x${image.height}.`,
    );
  }
  return (y * image.width + x) * 4;
};

const readRgbaPixel = (
  image: SimpleImageData,
  x: number,
  y: number,
): RgbaPixel => {
  const base = rgbaPixelOffset(image, x, y);
  return {
    r: image.data[base + 0] ?? 0,
    g: image.data[base + 1] ?? 0,
    b: image.data[base + 2] ?? 0,
    a: image.data[base + 3] ?? 0,
  };
};
```

Policy:

- `readRgbaPixel(...)` throws on invalid integer coordinates.
- Consumers either catch that error, pre-check with `isPixelInBounds(...)`, or use direct validated access in hot paths.
- Hot full-frame loops may use direct offset math after validating image dimensions once.
- Subpixel geometry uses interpolation/sampling helpers instead of integer pixel reads.

## Coordinate convention

The scanner's image-space coordinate convention is:

```text
integer pixel coordinates refer to pixel centers
pixel (x=10, y=20) has center at image point (10, 20)
continuous image points may use fractional coordinates
```

These are valid continuous image-space points:

```text
(10, 20)
(10.5, 20)
(10.25, 20.75)
```

Later finder geometry stores subpixel module centers and module edges. Geometry fitting keeps these points continuous. Rounding or interpolation belongs at image-sampling boundaries.
