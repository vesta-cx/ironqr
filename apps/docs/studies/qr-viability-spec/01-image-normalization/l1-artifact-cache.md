# Study Cache Note

Runtime scanning emits `SimpleImageData` and uses production `ViewBank` memoization for per-scan derived data. Benchmark/study tooling may additionally write this stage to disk as:

```text
L1 normalized frame
```

Study artifact metadata is explicit and separate from mutable runtime state:

```ts
interface NormalizedFrameArtifact {
  readonly image: SimpleImageData;
  readonly coordinateConvention: "pixel-centers-at-integers";
  readonly alphaCompositePolicy: "views-composite-on-white";
  readonly normalizedPixelFormat: "rgba-unorm8";
}
```

The metadata records pixel format, coordinate policy, and alpha policy so downstream geometry has no ambiguity.

Bump the study L1 cache version only when the meaning of normalized pixels changes, such as:

- different `ImageData` → `SimpleImageData` conversion semantics,
- different Float16/HDR handling,
- different alpha-composite policy,
- different decoded-frame validation semantics,
- different coordinate convention,
- different RGBA layout.

Media decode policy changes bump study L1 only when the resulting `SimpleImageData` bytes or metadata semantics change.
