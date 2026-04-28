# Runtime State Boundary

Derived views are runtime memoization owned outside L1 image data.

Target ownership:

```text
SimpleImageData
  width, height, Uint8ClampedArray RGBA data only

ViewBank / ScanContext
  scalar view cache
  binary view cache
  intermediate view cache
```

`ViewBank` / `ScanContext` owns runtime memoization.

Use “view” as the generic term for scanner-readable derived image data. Scalar views and binary views are both views. Current implementation details may store reusable intermediate buffers, such as polarity-free threshold bits for binary views or OKLab channel materialization for scalar views; those are intermediate view data, not L1 image data.
