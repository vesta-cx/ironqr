# Sauvola Threshold Math

Sauvola thresholding chooses a local cutoff per pixel.

It is useful when lighting changes across the image.

## Input

```text
values: Uint8Array
width: number
height: number
radius: number
```

Current default radius:

```text
radius = max(8, floor(min(width, height) / 8))
```

Current constants:

```text
k = 0.34
dynamicRange = 128
```

## Local window

For pixel `(x, y)`, define a rectangular neighborhood:

```text
left   = max(0, x - radius)
right  = min(width, x + radius + 1)
top    = max(0, y - radius)
bottom = min(height, y + radius + 1)
```

## Integral images

The pipeline builds summed-area tables:

```text
sum
sumSq
```

They allow rectangle sums in constant time:

```text
rectSum = table[bottom,right]
        - table[top,right]
        - table[bottom,left]
        + table[top,left]
```

This gives:

```text
localSum
localSumSq
area
```

## Local statistics

```text
mean = localSum / area
variance = max(0, localSumSq / area - mean²)
deviation = sqrt(variance)
```

## Sauvola formula

```text
threshold = mean × (1 + k × (deviation / dynamicRange - 1))
```

Then:

```text
value > threshold → 0 light
value <= threshold → 1 dark
```

## Intuition

Sauvola adapts to local brightness. A pixel can be dark relative to its neighborhood even if it is not globally dark.

## Strengths

- Handles uneven lighting.
- Helps photographed QR codes.
- Recovers local contrast that Otsu may miss.

## Weaknesses

- Can turn texture into QR-like binary patterns.
- Can create many finder candidates on busy backgrounds.
- More expensive than Otsu.

## Empirical questions

- Which valid decodes require Sauvola views?
- Which false positives or empty-payload decodes come from Sauvola views?
- Does Sauvola need different ranking/budget treatment than Otsu?
