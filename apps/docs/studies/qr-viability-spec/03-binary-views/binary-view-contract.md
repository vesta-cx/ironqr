# Binary View Contract

A binary view is a materialized black/white view owned by `ViewBank`.

```ts
interface BinaryView {
  readonly id: BinaryViewId;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}
```

`data` stores QR-ink decisions as bytes:

```text
1 = dark / QR ink
0 = light / background
```

Detector hot loops read `view.data[index]` directly.

## Artifact metadata

For math-based QR viability, binary views include enough metadata for empirical accounting:

```ts
interface BinaryViewArtifact {
  readonly id: BinaryViewId;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  readonly thresholdParameters: Record<string, number>;
}
```

Useful threshold parameters:

```text
otsu threshold value
sauvola radius/k/dynamicRange
hybrid radius/global/adaptive weights
```

Current code does not expose all these values in the artifact, but the spec requires them before threshold behavior can be compared rigorously.
