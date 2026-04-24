# Generated Corpus

Related: [[corpus-cli/Corpus Strategy]]

## Scope
This note documents the generated-corpus design owned by `tools/corpus-cli`.

It does **not** define `packages/ironqr` scan behavior. It defines how synthetic QR assets are generated, stored, and described.

## Purpose
Build a bounded synthetic QR corpus that expands coverage without polluting the canonical reviewed corpus or exploding into a full cartesian product.

## Storage split
Keep generated assets separate from the canonical reviewed corpus.

- canonical reviewed corpus: `corpus/data/manifest.json`
- generated corpus: `corpus/generated/manifest.json`
- generated image assets: `corpus/generated/assets/`

Generated assets should not be silently merged into the canonical reviewed manifest.

## Manifest shape
The generated corpus reuses the normal corpus-asset shape, then adds optional `synthetic` metadata for generated assets.

That metadata should capture:
- generator identity and version when available
- whether the asset is a `base` or `derived` variant
- deterministic seed
- payload type and structured payload fields
- exact encoded QR text
- appearance settings used to render the base symbol
- layered transformation steps applied afterward
- parent asset ids for derived variants

## Base generation policy
Base assets come from `~/Development/mia-cx/qr`.

Current payload domains should stay believable and user-owned:
- `ironqr.dev`
- `qrfor.ge`

Supported payload families currently include:
- `url`
- `text`
- `wifi`
- `phone`
- `sms`
- `email`
- `vcard`
- `calendar`
- `geo`
- `mecard`

The goal is not random text spam. The goal is realistic QR content rendered through varied appearance settings.

## Appearance variation policy
Base generation should vary presentation enough to produce real decode stress:
- theme / foreground-background colors
- error correction level
- pixel size
- module style
- cap style
- connection mode
- dot size
- optional frame text

Avoid duplicate appearance keys for the same payload family.

## Distortion policy
Derived assets should be built from a recipe catalog, but recipes should be **sampled**, not cartesian-expanded across every base asset.

Current rule:
- every distortion recipe must be applied to **at least 1** base asset
- every distortion recipe must be applied to **at most 3** base assets

This keeps the output large enough to matter, but bounded enough to remain intentional.

## Size target
Target roughly a couple thousand generated outputs by combining:
- about 1000 base QR assets
- sampled derived variants from the recipe catalog

The objective is breadth under a budget, not exhaustive combinatorics.

## Distortion families
The recipe catalog should cover a mix of realistic failure modes, including families such as:
- perspective
- squish
- bulge
- cylinder-wrap
- noise
- blur
- quiet-zone erosion
- deadzone / occlusion
- rotation
- compression
- contrast shifts
- background blending
- multi-step combo recipes

## Background compositing policy
When background blending is used, prefer approved canonical `non-qr-negative` assets as the background source.

That preserves a useful connection between synthetic foregrounds and real-world negative texture/background clutter.

## Backend policy
Prefer still-image tooling in this order:
1. **ImageMagick first**
2. **ffmpeg fallback** where useful

The default should stay ImageMagick-first unless a specific transformation is materially better elsewhere.

## Commands
Current root entry points are:

```bash
bun run corpus:generate-bases --count-per-type 100
bun run corpus:generate-distortions --coverage-min 1 --coverage-max 3
```

These commands belong to `tools/corpus-cli` even though the root package forwards them.

## Design constraint
Generated data is a complement to the reviewed real-world corpus, not a replacement for it.

Synthetic assets are useful for controlled stress and broad coverage. They should not become the only evidence used to tune `ironqr` policy.
