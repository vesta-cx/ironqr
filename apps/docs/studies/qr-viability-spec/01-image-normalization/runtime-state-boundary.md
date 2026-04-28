# Runtime State Boundary

Derived views are runtime memoization owned outside L1 image data.

Target ownership:

```text
SimpleImageData
  width, height, Uint8ClampedArray RGBA data only

ViewBank
  scalar view cache
  binary view cache
  derived view backing stores
```

`ViewBank` owns runtime memoization.

Use “view” as the generic term for scanner-readable derived image data. Scalar views and binary views are both views.

A view may be backed by stored bytes or by a lightweight adapter over another backing store. For example, normal and inverted binary views can share one threshold backing store and calculate polarity on read instead of materializing two buffers.

`ViewBank` owns both view objects and their backing stores. These backing stores support views, but they are not separate view kinds and not L1 image data.
