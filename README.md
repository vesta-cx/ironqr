# ironqr Monorepo

Bun workspace monorepo with Turbo as the task runner. The publishable SDK,
corpus tooling, benchmarking, and the wasm-facing JS boundary each live in
their own workspace package.

## Workspaces

- `packages/ironqr`: `ironqr`, the publishable QR SDK package
- `tools/corpus-cli`: `ironqr-corpus-cli`, local corpus import, review, staging, and bench-curation tooling
- `tools/bench`: `@ironqr/bench`, corpus-wide accuracy and performance benchmarking CLI
- `tools/perfbench`: `@ironqr/perfbench`, older synthetic and real-world benchmark harness
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
bun run bench accuracy
bun run bench accuracy --refresh-cache
bun run bench accuracy --no-cache
bun run bench accuracy --no-progress
bun run bench accuracy --workers 8
bun run bench performance
bun run benchmark
bun --filter ironqr-corpus-cli run cli --
bun --filter ironqr-corpus-cli run cli -- scrape --label qr-positive https://example.com
bun --filter ironqr-corpus-cli run cli -- review corpus/staging/<run-id>
bun --filter ironqr-corpus-cli run cli -- import path/to/file.png
bun --filter ironqr-corpus-cli run cli -- import corpus/staging/<run-id>
bun --filter ironqr-corpus-cli run cli -- build-bench
```

The publishable package documentation remains in `packages/ironqr/README.md`.
