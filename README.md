# ironqr Monorepo

Bun workspace monorepo with Turbo as the task runner. The publishable SDK,
corpus tooling, benchmarking, and the wasm-facing JS boundary each live in
their own workspace package.

## Workspaces

- `packages/ironqr`: `ironqr`, the publishable QR SDK package
- `tools/corpus-cli`: `ironqr-corpus-cli`, local corpus import, review, staging, and export tooling
- `tools/perfbench`: `@ironqr/perfbench`, synthetic and real-world benchmark harness
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
bun --filter ironqr-corpus-cli run cli -- import-local --label qr-positive path/to/file.png
bun --filter ironqr-corpus-cli run cli -- scrape-remote --label qr-positive https://example.com
bun --filter ironqr-corpus-cli run cli -- review-staged corpus/staging/<run-id>
bun --filter ironqr-corpus-cli run cli -- import-staged corpus/staging/<run-id>
bun --filter ironqr-corpus-cli run cli -- export-benchmark
```

The publishable package documentation remains in `packages/ironqr/README.md`.
