# Tier 3 — IronQR-Owned Decoder

Add an IronQR-owned decoder for a format when platform decode and existing format libraries cannot satisfy the product/runtime requirement.

## Entry criteria

Use this branch when all conditions hold:

```text
format support is a product requirement
platform decode cannot provide consistent target-runtime support
existing libraries fail runtime, license, safety, maintenance, or ImageData-output requirements
implementation scope is justified by fixtures and product usage
```

## Potential implementations

Implementation options:

```text
browser WASM decoder
Node/native decoder
future Rust-backed decoder
```

The decoder still emits browser `ImageData` at the stage boundary.

```text
IronQR-owned decoder → ImageData
```

## Required behavior

The decoder implementation defines:

```text
accepted source signatures
source byte limits
metadata dimension preflight when available
orientation handling
color-profile handling
alpha behavior
animated/multi-frame selection policy when the format supports it
failure modes and error codes
```

## Validation

This branch requires fixtures before product use:

```text
valid fixture for every supported format variant
malformed fixture
oversized-dimension fixture when container metadata permits it
orientation fixture when the format can carry orientation metadata
color-profile fixture when the format can carry color metadata
alpha fixture when the format can carry transparency
large-image budget fixture
```

Stage 01 still validates decoded dimensions, area, buffer type, and buffer length.

## Escalation

Route to [Tier 4 — Actionable Rejection](./tier-4-actionable-rejection.md) when:

```text
format support is not a product requirement
safe decoder implementation is unavailable
implementation cost exceeds product value
```
