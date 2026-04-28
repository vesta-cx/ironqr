# 04 — Finder Detection

Finder detection looks at a binary view and finds local image structures that might be QR finder patterns.

A finder detector should not decide that a whole QR exists. It should only say:

```text
this local region looks like one finder pattern
```

Later stages decide whether three finders can form a realistic QR grid.

## Current input

Input is one binary view:

```ts
interface BinaryView {
  id: BinaryViewId;
  width: number;
  height: number;
  plane: BinaryPlane;
  polarity: BinaryPolarity;
}
```

The detector reads pixels as:

```text
0   = dark byte
255 = light byte
```

or equivalently:

```text
1 = dark bit
0 = light bit
```

## Current detector families

Current canonical production-like detector families:

```ts
['row-scan', 'matcher']
```

`flood` exists historically but is not in the default detector policy.

## Finder-pattern shape

A QR finder pattern has a 1:1:3:1:1 run ratio through its center:

```text
black white black white black
  1     1     3     1     1
```

Across a center row it looks like:

```text
# . ### . #
```

The same idea appears vertically through the center.

The detectors use this ratio as the cheap local signal.

---

## Row-scan detector

The row-scan detector sweeps across image rows and looks for five-run patterns.

A run is a consecutive sequence of same-colored pixels.

Example row:

```text
.....###..#######..###.....
```

A detector may count:

```text
light run
black run
white run
black run
white run
black run
light run
```

For a finder center, the important middle five runs should approximate:

```text
1 : 1 : 3 : 1 : 1
```

### Ratio scoring

The current ratio score computes:

```text
total = count0 + count1 + count2 + count3 + count4
moduleSize = total / 7
```

Expected counts:

```text
count0 ≈ 1 × moduleSize
count1 ≈ 1 × moduleSize
count2 ≈ 3 × moduleSize
count3 ≈ 1 × moduleSize
count4 ≈ 1 × moduleSize
```

Error:

```text
error = Σ abs(actual - expected) / moduleSize
```

If the error is too high, reject.

Current guard:

```text
if total < 7, reject
```

That effectively means accepted row-scan/cross-check finder evidence has at least about:

```text
moduleSize >= 1 pixel/module
```

### Cross-checking

A horizontal row hit is not enough. The detector cross-checks vertically and horizontally around the estimated center.

Current flow:

```text
row hit
→ estimate centerX
→ vertical cross-check at centerX
→ horizontal cross-check at refined centerY
→ construct finder evidence
```

This helps reject accidental one-dimensional stripe patterns.

---

## Matcher detector

The matcher detector checks likely center pixels and runs the same kind of cross-checks.

Current rough flow:

```text
step through image pixels
→ skip pixels that are not dark centers
→ horizontal cross-check
→ vertical cross-check
→ combine into matcher evidence
```

The step size adapts to image size:

```text
step = max(1, floor(min(width, height) / 180))
```

So small images are scanned densely, while larger images skip some pixels for speed.

Matcher evidence is rejected if the combined module size is below:

```text
0.8 px/module
```

However, because the cross-check ratio scorer rejects total run length below 7, current row/matcher accepted evidence is practically still around `>= 1 px/module`.

---

## Flood detector, historical note

Flood-style finder detection looked for connected dark rings and center stones.

It can estimate module size from area:

```text
moduleSize = sqrt(ringPixelCount / 24)
```

It accepts components with at least:

```text
pixelCount >= 16
```

So flood could theoretically emit module estimates below 1 px/module. It is not part of the current canonical detector policy.

---

## Current detector output

Detectors emit `FinderEvidence` records. Current shape:

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

This is cheap and useful, but it is not rich enough for final math-based realism.

## Deduplication and caps

Detectors can emit many nearby hits for the same physical finder.

The pipeline clusters nearby finder evidence. The distance threshold scales with module size but has a floor:

```text
distance < max(2, min(moduleSizeA, moduleSizeB) × factor)
```

This prevents tiny module estimates from making duplicate clustering too strict.

Current caps keep finder work bounded:

```text
MAX_FINDER_EVIDENCE_TOTAL = 12
```

## Target detector responsibility

For the math-based realism pipeline, finder detection should remain a **candidate generator**.

It should answer:

```text
Where should finder geometry refinement look?
What rough scale should refinement try?
Which detector/view produced this seed?
```

It should not be responsible for proving full QR realism.

## Empirical questions

The study should measure:

| Question | Why |
| --- | --- |
| Which detector family produces finders that lead to valid decodes? | Validate row-scan/matcher policy. |
| Which detector family produces false positives or empty payload decodes? | Understand risk. |
| How many finder seeds per view are needed before recall stops improving? | Work cap tuning. |
| How often do row-scan and matcher agree on the same finder? | Confidence/support signal. |
| Do small module-size finders ever lead to valid decode? | Decide min module-size policy. |

## Cache boundary

This is part of L4 in the scanner artifact cache:

```text
L4 finder evidence
```

Later, if we add richer finder geometry refinement, it may deserve a new boundary:

```text
L4a finder seeds
L4b refined finder geometry
```

That separation would let studies reuse cheap seed detection while changing refinement math.
