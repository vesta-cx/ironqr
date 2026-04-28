# Input and Output

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

`BinaryViewId` is the canonical source of scalar-view, threshold-method, and polarity metadata.

## Output

Detectors emit finder seeds.

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

For this stage, treat `FinderEvidence` as a cheap seed, not final QR geometry truth.

The seed must provide:

```text
where finder geometry refinement should look
what rough scale refinement should try
which detector/view produced this seed
```

Later stages refine local finder geometry and decide whether three finders form a realistic QR grid.
