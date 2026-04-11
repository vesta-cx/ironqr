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
- `corpus/data/assets/` — imported image files, normalized to WebP and named by content hash id
- `corpus/data/benchmark-real-world.json` — generated benchmark export

Remote scrape staging lives under `corpus/staging/`:

- `corpus/staging/<run-id>/<asset-id>/image.*` — raw scraped image for manual review
- `corpus/staging/<run-id>/<asset-id>/manifest.json` — per-image source metadata

Both `corpus/data/` and `corpus/staging/` are gitignored. The code and docs in
`corpus/` are tracked; the imported dataset is local working data unless the
team explicitly chooses to version specific approved fixtures later.

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
bun --filter ironqr-corpus-cli run cli -- import-local --label qr-positive --review approved path/to/file.png
bun --filter ironqr-corpus-cli run cli -- scrape-remote --label qr-positive --limit 25 https://pixabay.com/images/search/qr%20code/
bun --filter ironqr-corpus-cli run cli -- review-staged corpus/staging/<run-id>
bun --filter ironqr-corpus-cli run cli -- import-staged corpus/staging/<run-id>
bun --filter ironqr-corpus-cli run cli -- export-benchmark
```

## Review flow

1. `scrape-remote` downloads raw images into `corpus/staging/<run-id>/...`.
2. `review-staged` prompts for the reviewer GitHub username, then walks the staged
   queue one image at a time.
3. On approval, the reviewer confirms or edits the best-effort license, enters the
   number of QR codes present, then the tool runs the current scanner as a review
   assist. If the auto-scan result is correct, it can be accepted as ground truth;
   otherwise the reviewer can enter the payloads manually.
4. `import-staged` imports approved staged assets into the real corpus manifest.

`import-local` and `import-staged` both normalize imported assets to WebP and
scale them down to fit within 1000×1000 while preserving aspect ratio. Staged
assets remain raw so review is based on the original downloaded file.

The benchmark export only includes assets whose review status is `approved`.
That keeps #5 evaluation tied to reviewed seed data instead of every raw import.
