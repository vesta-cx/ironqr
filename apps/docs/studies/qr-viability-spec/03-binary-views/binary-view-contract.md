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

Threshold parameters are study/report metadata, not runtime view data. Study tooling records them keyed by `BinaryViewId` for empirical accounting.

Useful study threshold parameters:

```text
otsu threshold value
sauvola radius/k/dynamicRange
hybrid radius/global/adaptive weights
```

Reports need threshold parameters before threshold behavior can be compared rigorously.
