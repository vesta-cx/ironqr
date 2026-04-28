# Otsu Threshold Math

Otsu thresholding chooses one global cutoff for a scalar view.

It is useful when foreground and background form two mostly separate brightness groups.

## Input

```text
data: Uint8Array
```

Each value is `0..255`.

## Histogram

Build a count for each byte value:

```text
histogram[v] = number of pixels with value v
```

for:

```text
v = 0..255
```

## Candidate threshold

For each threshold `t`, split pixels into two classes:

```text
background = data <= t
foreground = data > t
```

Compute:

```text
backgroundWeight = number of background pixels
foregroundWeight = number of foreground pixels
meanBackground = average value in background
meanForeground = average value in foreground
```

## Between-class variance

Otsu chooses the threshold that maximizes:

```text
variance = backgroundWeight × foregroundWeight × (meanBackground - meanForeground)^2
```

Intuition:

```text
Good threshold = two large groups whose means are far apart
```

## Output bit rule

The scanner encodes a polarity-free dark bit:

```text
value > threshold → 0 light
value <= threshold → 1 dark
```

Polarity is applied later by `BinaryView` reads.

## Strengths

- Cheap.
- Deterministic.
- Good for strong global contrast.

## Weaknesses

- Poor with uneven lighting.
- Poor with shadows/glare.
- Can miss QR modules when background intensity varies across the image.

## Validation metrics

- Valid finder triples from Otsu views compared with local thresholds.
- Otsu false-positive rate compared with Sauvola/hybrid.
- Decode contribution from Otsu after scalar/channel expansion.
