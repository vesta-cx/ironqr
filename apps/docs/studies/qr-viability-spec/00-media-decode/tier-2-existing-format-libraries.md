# Tier 2 — Existing Format Libraries

For widely used formats with mature browser, WASM, Node, or native bindings, integrate an existing implementation before adding IronQR-owned decoder code.

## Selection criteria

Use a library when it provides:

```text
maintained implementation
browser or Node binding suitable for target runtime
clear license
bounded memory behavior
ImageData output or straightforward ImageData conversion
fixture coverage for orientation, color, alpha, and large-image behavior
```

## Explicit target: HEIC / HEIF

HEIC / HEIF support is required for practical iPhone uploads.

Policy:

```text
try platform decode if supported
detect HEIC/HEIF when platform decode is unavailable
use an existing HEIC/HEIF decoder binding that satisfies the selection criteria
return ImageData
```

HEIC/HEIF are ISO BMFF-family files. Detection often uses the `ftyp` box and brands such as:

```text
heic
heix
hevc
hevx
mif1
msf1
```

## Output

The branch output is browser `ImageData`.

```text
existing decoder binding → ImageData
```

If the library returns another RGBA representation, the branch adapts that result to browser `ImageData` before stage 01.

## Validation

This branch validates:

```text
format detection confidence
source byte cap before decode
library decode success/failure
ImageData construction after decode
early dimensions when container/header parsing exposes them
```

Stage 01 still validates decoded dimensions, area, buffer type, and buffer length.

## Escalation

Route to [Tier 3 — IronQR-Owned Decoder](./tier-3-ironqr-owned-decoder.md) when:

```text
platform decode cannot satisfy the requirement
existing libraries cannot satisfy the runtime, license, safety, or output contract
product support for the format remains required
```
