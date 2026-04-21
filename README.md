# ironqr Monorepo

Bun workspace monorepo with Turbo as the task runner. The publishable SDK,
corpus tooling, benchmarking, and the wasm-facing JS boundary each live in
their own workspace package.

## Workspaces

- `packages/ironqr`: `ironqr`, the publishable QR SDK package
- `tools/corpus-cli`: `ironqr-corpus-cli`, local corpus import, review, and staging tooling
- `tools/bench`: `@ironqr/bench`, benchmark CLI with `performance` and `accuracy` modes
- `tools/perfbench`: `@ironqr/perfbench`, legacy synthetic benchmark internals feeding the bench CLI during migration
- `packages/wasm`: `@ironqr/wasm`, the experimental JS-facing wasm boundary over `rust/`

## Common Commands

```bash
bun install
bun run build
bun run test
bun run lint
bun run typecheck
bun run package:quality
```

## Targeted Commands

```bash
bun run benchmark
bun run bench performance
bun run bench engines
bun run bench accuracy --engine ironqr --failures-only
bun --filter ironqr-corpus-cli run cli --
bun --filter ironqr-corpus-cli run cli -- scrape --label qr-positive https://example.com
bun --filter ironqr-corpus-cli run cli -- review corpus/staging/<run-id>
bun --filter ironqr-corpus-cli run cli -- import path/to/file.png
bun --filter ironqr-corpus-cli run cli -- import corpus/staging/<run-id>
bun --filter ironqr-corpus-cli run cli -- build-bench
```

`tools/bench` now includes a first bridge adapter protocol for engines that must run outside Bun, such as browser-native `BarcodeDetector` harnesses. Configure those engines by pointing the relevant environment variable at a command that reads one JSON request from stdin and prints one JSON response to stdout:

```bash
export IRONQR_BENCH_BARCODE_DETECTOR_COMMAND='node path/to/barcode-detector-bridge.mjs'
bun run bench engines
bun run bench accuracy --engine barcode-detector --failures-only
```

The publishable package documentation remains in `packages/ironqr/README.md`.
