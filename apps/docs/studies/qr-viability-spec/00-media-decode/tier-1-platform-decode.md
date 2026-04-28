# Tier 1 — Platform Decode

Platform decode is the MVP media-decode branch.

Use the active runtime's image decoder when it can produce browser `ImageData` for the input format.

## Implementations

Browser implementations:

```text
createImageBitmap
canvas drawImage + getImageData
ImageDecoder when available
```

Node/native implementations:

```text
maintained native image decoder bindings
runtime image APIs that produce an RGBA buffer convertible to ImageData
```

## Common formats

Platform decoders commonly cover:

```text
PNG
JPEG
WebP
GIF
BMP
AVIF
SVG image sources where safe and explicitly allowed
```

Actual support depends on the runtime.

## Output

The branch output is browser `ImageData`.

```text
platform decoder → ImageData
```

Stage 01 then normalizes that `ImageData` into `SimpleImageData`.

## Validation

This branch validates:

```text
source kind is supported by the platform path
source byte cap before decode when source is compressed
early dimensions when platform metadata exposes them
decoder success/failure
canvas/context availability when canvas is part of the path
```

Stage 01 still validates decoded dimensions, area, buffer type, and buffer length.

## MVP fallback

For the MVP, platform decode failure routes to [Tier 4 — Actionable Rejection](./tier-4-actionable-rejection.md):

```text
platform decoder lacks the format
platform decoder fails for the source
platform decoder API is unavailable
```

## Post-MVP escalation

After the MVP, route to [Tier 2 — Existing Format Libraries](./tier-2-existing-format-libraries.md) when:

```text
platform decoder lacks the format
platform decoder exists only in some target runtimes
platform decoder behavior is insufficient for product requirements
format support is a product requirement
```
