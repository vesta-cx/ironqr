# Validation

Validation happens at the decoded-frame trust boundary.

Shared image dimension limits:

```ts
export const MAX_IMAGE_DIMENSION = 8192;
export const MAX_IMAGE_PIXELS = 35_389_440; // 8192 × 4320
```

These constants are shared by stage 00 metadata preflight and stage 01 decoded-frame validation. Define and export them from one shared image-limits module so stages use the same budget without duplicating literals.

The scanner rejects:

- non-safe-integer dimensions,
- zero or negative dimensions,
- width/height above max side length,
- total area above max pixel count,
- unsupported decoded frame buffer type,
- RGBA buffers with wrong length.

For canonical output, downstream stages may assume:

```text
width > 0
height > 0
data instanceof Uint8ClampedArray
data.length === width × height × 4
```

`height` is kept as explicit metadata even though it is derivable from buffer length and width. The explicit invariant is clearer and catches mismatched buffers:

```text
data.length === width × height × 4
```

## Validation metrics

This stage affects every later QR signal. Reports must track:

| Metric | Purpose |
| --- | --- |
| Rejected decoded pixel formats | Ensure Float16/HDR inputs follow explicit conversion/rejection policy. |
| Normalization conversion counts | Track when stage 01 converts vs accepts directly. |
| Transparent asset behavior | QR artwork may rely on transparency. |
| Very large image materialization time | Cache and budget planning. |
| Source-dimension correlation with decode/finder failures | Very small modules can become unresolvable. |
| 8192×4320 area budget behavior across browser, Node, native, and WASM backends | Product input guarantee. |
