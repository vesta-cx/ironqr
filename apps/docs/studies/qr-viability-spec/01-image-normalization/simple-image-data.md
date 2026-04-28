# SimpleImageData

The canonical IronQR frame is `SimpleImageData`:

```ts
interface SimpleImageData {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}
```

| Field    | Meaning                                             |
| -------- | --------------------------------------------------- |
| `width`  | Image width in pixels.                              |
| `height` | Image height in pixels.                             |
| `data`   | Flat row-major RGBA byte buffer, 4 bytes per pixel. |

`SimpleImageData` uses the subset of browser `ImageData` that IronQR needs:

```text
width
height
Uint8ClampedArray RGBA data
```

Runtime-specific `ImageData` features stay on the stage-00 side of the boundary:

```text
colorSpace
pixelFormat
Float16Array HDR data
methods / DOM object identity
```

Current implementation uses `rgbaPixels` rather than `data`. This spec prefers `data` to match `ImageData` unless implementation evidence shows that `rgbaPixels` avoids confusion. Either way, the canonical artifact is the same semantic object: width, height, and `Uint8ClampedArray` RGBA bytes.
