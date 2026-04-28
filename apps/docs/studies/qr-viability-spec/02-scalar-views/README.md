# 02 — Scalar Views

Scalar views turn `SimpleImageData` RGBA pixels into one grayscale-like number per pixel.

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

## Stage notes

| Note                                                     | Contract                                                               |
| -------------------------------------------------------- | ---------------------------------------------------------------------- |
| [Scalar view contract](./scalar-view-contract.md)        | Runtime `ScalarView` shape and study artifact metadata.                |
| [Scalar view registry](./scalar-view-registry.md)        | Current scalar view ids and grouping metadata.                         |
| [Grayscale view](./grayscale-view.md)                    | Rec. 601 luma scalar view.                                             |
| [RGB channel views](./rgb-channel-views.md)              | `r`, `g`, and `b` scalar views.                                        |
| [OKLab views](./oklab-views.md)                          | `ok-l`, `ok-a`, and `ok-b` scalar views.                       |
| [OKLab math](./math-oklab.md)                            | Detailed OKLab conversion and encoding math.                           |
| [Scalar selection policy](./scalar-selection-policy.md)  | Why the scalar set exists and current proposal-view priority evidence. |
| [Validation](./validation.md)                            | Contribution, rescue, false-positive, and proposal-volume metrics.     |
| [Study cache note](./l2-artifact-cache.md)               | Study-only artifact metadata and versioning.                           |

## Output

Stage 02 emits `ScalarView` objects owned by `ViewBank`:

```ts
interface ScalarView {
  readonly id: ScalarViewId;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}
```

The emitted view satisfies:

```text
width === input.width
height === input.height
data.length === width × height
data[pixel] ∈ 0..255
```
