# 03 — Binary Views

Binary views turn scalar values into materialized black/white QR-ink decisions.

This stage defines threshold methods and polarity semantics.

## Input

Input is one scalar view:

```ts
interface ScalarView {
  readonly id: ScalarViewId;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array; // 0..255
}
```

## Stage notes

| Note | Contract |
| --- | --- |
| [Binary view contract](./binary-view-contract.md) | Runtime `BinaryView` shape and study artifact metadata. |
| [Binary view id](./binary-view-id.md) | Composite id format and metadata ownership. |
| [Threshold methods](./threshold-methods.md) | Otsu, Sauvola, and hybrid threshold responsibilities. |
| [Otsu math](./math-otsu.md) | Detailed Otsu threshold math. |
| [Sauvola math](./math-sauvola.md) | Detailed Sauvola threshold math. |
| [Hybrid math](./math-hybrid.md) | Detailed hybrid threshold math. |
| [Polarity](./polarity.md) | Normal/inverted materialization policy. |
| [Validation](./validation.md) | Decode, false-positive, rescue, and work-reduction metrics. |
| [Study cache note](./l3-study-cache.md) | Study-only artifact metadata and versioning. |

## Output

Stage 03 emits `BinaryView` objects owned by `ViewBank`:

```ts
interface BinaryView {
  readonly id: BinaryViewId;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}
```

The emitted view satisfies:

```text
width === scalarView.width
height === scalarView.height
data.length === width × height
data[pixel] ∈ {0, 1}
```

Every scalar-view/threshold-method pair emits both polarities:

```text
normal
inverted
```
