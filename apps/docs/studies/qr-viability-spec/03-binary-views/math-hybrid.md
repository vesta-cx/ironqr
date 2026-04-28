# Hybrid Threshold Math

Hybrid thresholding blends global Otsu thresholding with local mean/deviation statistics.

It is a rescue-family threshold for hard photographed assets.

## Input

```text
data: Uint8Array
width: number
height: number
radius: number
```

Current default radius:

```text
radius = max(6, floor(min(width, height) / 10))
```

Current constants:

```text
HYBRID_DEVIATION_WEIGHT = 0.08
HYBRID_GLOBAL_WEIGHT = 0.45
HYBRID_ADAPTIVE_WEIGHT = 0.55
```

## Step 1: global anchor

Compute Otsu's global threshold:

```text
global = otsuThreshold(data)
```

This gives a stable image-wide brightness cutoff.

## Step 2: local adaptive estimate

For each pixel, compute local mean and deviation using integral images:

```text
mean
variance
deviation = sqrt(variance)
```

Then:

```text
adaptive = mean - deviation × 0.08
```

## Step 3: blended threshold

```text
threshold = global × 0.45 + adaptive × 0.55
```

Then:

```text
value > threshold → 0 light
value <= threshold → 1 dark
```

## Intuition

Otsu is stable but too global. Sauvola is adaptive but can be noisy.

Hybrid tries to keep global stability while allowing local rescue.

## Strengths

- Often useful for hard images where Otsu misses local contrast.
- Less purely local than Sauvola.
- Useful in measured proposal-view ordering.

## Weaknesses

- Still can create texture-derived false finders.
- Constants are heuristic and must remain evidence-backed.

## Validation metrics

- Assets rescued only by hybrid views.
- False-positive empty decode delta from hybrid views.
- Best execution position for hybrid views: early, late, or after cheaper views fail.
