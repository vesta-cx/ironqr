# Scalar View Contract

A scalar view is a runtime-derived view owned by `ViewBank`. Benchmark/study tooling may persist the same bytes as study artifacts.

```ts
interface ScalarView {
  readonly id: ScalarViewId;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}
```

| Field             | Meaning                                             |
| ----------------- | --------------------------------------------------- |
| `id`              | Stable scalar view id, such as `gray` or `ok-l`. |
| `width`, `height` | Same dimensions as input `SimpleImageData`.         |
| `data`            | One byte per pixel.                                 |

Current implementation may still call the byte array `values`. This spec uses `data` consistently with `SimpleImageData` and later view types.

View grouping belongs in static view registry metadata, keyed by `ScalarViewId`, rather than on every `ScalarView` object.

## Artifact metadata

For math-based QR viability, scalar views remain simple, while reports preserve contribution accounting:

```ts
interface ScalarViewArtifact {
  readonly id: ScalarViewId;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  readonly formula: string;
}
```

The formula metadata helps compare behavior across view changes.
