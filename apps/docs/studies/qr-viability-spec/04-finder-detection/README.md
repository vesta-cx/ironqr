# 04 — Finder Detection

Finder detection looks at a binary view and finds local image structures that might be QR finder patterns.

A finder detector emits local finder seeds. Later stages decide whether three finders form a realistic QR grid.

## Input

Input is one materialized binary view from stage 03:

```ts
interface BinaryView {
  readonly id: BinaryViewId;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}
```

The detector reads pixels as:

```text
1 = dark / QR ink
0 = light / background
```

## Stage notes

| Note | Contract |
| --- | --- |
| [Input and output](./input-output.md) | Binary input and finder-seed output contracts. |
| [Finder pattern shape](./finder-pattern-shape.md) | 1:1:3:1:1 local finder signal. |
| [Detector policy](./detector-policy.md) | Canonical detector families and candidate-generator responsibility. |
| [Row-scan detector](./row-scan-detector.md) | Row run scanning, ratio scoring, and cross-checking. |
| [Matcher detector](./matcher-detector.md) | Center-pixel matcher flow and step-size policy. |
| [Flood detector history](./flood-detector-history.md) | Historical non-canonical detector context. |
| [Deduplication and caps](./deduplication-and-caps.md) | Duplicate clustering and finder evidence caps. |
| [Validation](./validation.md) | Decode, false-positive, agreement, cap, and module-size metrics. |
| [Study cache note](./l4-study-cache.md) | Study-only artifact metadata and versioning. |

## Output

Stage 04 emits finder seeds.

Current code calls these `FinderEvidence` records:

```ts
interface FinderEvidence {
  readonly source: ProposalSource;
  readonly centerX: number;
  readonly centerY: number;
  readonly moduleSize: number;
  readonly hModuleSize: number;
  readonly vModuleSize: number;
  readonly score?: number;
}
```

`FinderEvidence` is a seed for later geometry refinement, not final QR geometry truth.
