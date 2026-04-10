# Real-world corpus toolkit

This directory contains the first-pass tooling for importing real QR-positive and
non-QR-negative image assets into a manifest-driven local corpus.

## Goals

- deterministic local import
- content-hash deduplication
- provenance captured per asset
- explicit review status per asset
- direct export into benchmark-ready positive/negative lists

## On-disk layout

Runtime data lives under `corpus/data/`:

- `corpus/data/manifest.json` — canonical manifest
- `corpus/data/assets/` — imported image files, named by content hash id
- `corpus/data/benchmark-real-world.json` — generated benchmark export

`corpus/data/` is gitignored. The code and docs in `corpus/` are tracked; the
imported dataset is local working data unless the team explicitly chooses to
version specific approved fixtures later.

## Lawful sourcing and review expectations

Only import assets you are allowed to use for evaluation.

For every asset, capture enough provenance to answer:
- where it came from
- what rights or permission basis we have to store and evaluate it
- whether attribution is required
- whether a human has reviewed the label and asset quality

Do not treat unlabeled scraped imagery as production-ready test data.
Imported assets should begin as `pending` unless someone has actually reviewed
and approved them.

Recommended review checklist:
- label is correct (`qr-positive` vs `non-qr-negative`)
- image is actually usable (not truncated, corrupt, or unrelated)
- provenance / attribution / license notes are present when needed
- duplicates are intentional, or should be collapsed

## Commands

```bash
bun run corpus/cli.ts import-local --label qr-positive --review approved path/to/file.png
bun run corpus/cli.ts import-local --label non-qr-negative path/to/negative.jpg
bun run corpus/cli.ts export-benchmark
```

The benchmark export only includes assets whose review status is `approved`.
That keeps #5 evaluation tied to reviewed seed data instead of every raw import.
