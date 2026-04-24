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
- `corpus/data/benchmark-real-world.json` — optional local export of all approved assets

Committed perfbench fixture lives under `tools/perfbench/fixtures/real-world/`:

- `tools/perfbench/fixtures/real-world/manifest.json` — curated committed benchmark snapshot
- `tools/perfbench/fixtures/real-world/assets/` — copied fixture assets used by perfbench

Remote scrape staging lives under `corpus/staging/`:

- `corpus/staging/<run-id>/<asset-id>/image.*` — raw scraped image for manual review
- `corpus/staging/<run-id>/<asset-id>/manifest.json` — per-image source metadata

`corpus/staging/` is gitignored. `corpus/data/` (manifest, assets, rejections)
is tracked in the repo so the seed corpus ships out of the box and CI can
exercise real-world images without a local scrape.

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
bun run corpus
bun run corpus:scrape --limit 25 --source commons --query 'QR Code'
bun run corpus:scrape --limit 25 --source pixabay-api --query 'qr code'
bun run corpus:scrape --limit 25 https://commons.wikimedia.org/w/index.php?search=QR+Code&title=Special%3AMediaSearch&type=image
bun run corpus:scrape --limit 25 'https://pixabay.com/api/?q=qr+code&image_type=photo&safesearch=true&order=popular'
bun run corpus:review corpus/staging/<run-id>
bun run corpus:import path/to/file.png
bun run corpus:import corpus/staging/<run-id>
bun run corpus:build-bench
bun run corpus:generate-bases --count-per-type 100
bun run corpus:generate-distortions --coverage-min 1 --coverage-max 3
```

Missing required args prompt in TTY sessions.
Interactive `scrape` prompts can pick a preset seed source (Wikimedia Commons or Pixabay API) or enter custom URL(s).
`--source commons|pixabay-api` selects a preset non-interactively; `--query` customizes the preset search term.
No subcommand runs guided scrape → review → import flow.

## Pixabay API setup

Create a single repo-root `.env` file, then the `tools/corpus-cli/.env` symlink will pick it up automatically:

```bash
PIXABAY_API_KEY=your_api_key_here
```

The corpus CLI uses the official Pixabay API instead of scraping Cloudflare-protected search HTML.
To match Pixabay's API rules, the tool now:

- caches Pixabay API search requests for 24 hours under `.sc/request-cache/`
- records Pixabay provenance and creator attribution on staged assets
- downloads images into local staging/corpus storage instead of hotlinking Pixabay URLs
- keeps the human review/import step in the loop for every asset
- removes artificial per-request sleeps for sub-100-image Pixabay staging runs, then falls back to a 750ms adapter throttle for larger runs

## Review flow

1. `scrape` downloads raw images into `corpus/staging/<run-id>/...`.
2. `review` prompts for reviewer GitHub username, then walks staged queue one image at a time.
3. On approval, reviewer confirms or edits best-effort license, enters QR count, then tool runs current scanner as review assist. If auto-scan result is correct, it can be accepted as ground truth; otherwise reviewer can enter payloads manually.
4. `import` imports approved staged assets into real corpus manifest and fills missing required metadata.
5. `build-bench` lets user hand-curate committed perfbench fixture from approved corpus assets.

Local and staged imports both normalize imported assets to WebP and scale them down to fit within 1000×1000 while preserving aspect ratio. Staged assets remain raw so review is based on original downloaded file.

Committed perfbench fixture only includes assets user explicitly selected during `build-bench`.
That keeps perfbench regression set small, stable, and reviewable.

## Generated QR corpus

Synthetic QR assets live under `corpus/generated/` and are intentionally kept separate from the canonical reviewed corpus under `corpus/data/`.

- `bun run corpus:generate-bases --count-per-type 100`
  - renders 100 stylized base QR images per payload type using `~/Development/mia-cx/qr`
  - stores exact structured payload fields and appearance settings in `corpus/generated/manifest.json`
- `bun run corpus:generate-distortions --coverage-min 1 --coverage-max 3`
  - builds a large distortion recipe catalog
  - applies every recipe to at least one, and at most three, base QR assets
  - records every applied transformation in `synthetic.transformations[]`

The generated manifest reuses the normal corpus-asset shape but adds optional `synthetic` metadata so generated bases and derived variants can record:

- payload type + structured payload fields
- exact encoded QR text
- appearance settings (theme, module style, dot size, frame text, etc.)
- layered distortions / compositing steps
- parent asset ids for derived variants
