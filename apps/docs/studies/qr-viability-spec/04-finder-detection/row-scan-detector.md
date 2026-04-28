# Row-Scan Detector

The row-scan detector sweeps across image rows and looks for five-run finder patterns.

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

For a finder center, the important middle five runs approximate:

```text
1 : 1 : 3 : 1 : 1
```

## Ratio scoring

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

Reject when the error exceeds the detector threshold.

Current guard:

```text
if total < 7, reject
```

That effectively means accepted row-scan/cross-check finder evidence has at least about:

```text
moduleSize >= 1 pixel/module
```

## Cross-checking

A horizontal row hit is not enough. The detector cross-checks vertically and horizontally around the estimated center.

Current flow:

```text
row hit
→ estimate centerX
→ vertical cross-check at centerX
→ horizontal cross-check at refined centerY
→ construct finder evidence
```

This rejects accidental one-dimensional stripe patterns.
