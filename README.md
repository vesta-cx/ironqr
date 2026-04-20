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
bun run bench accuracy --engine ironqr --failures-only
bun --filter ironqr-corpus-cli run cli --
bun --filter ironqr-corpus-cli run cli -- scrape --label qr-positive https://example.com
bun --filter ironqr-corpus-cli run cli -- review corpus/staging/<run-id>
bun --filter ironqr-corpus-cli run cli -- import path/to/file.png
bun --filter ironqr-corpus-cli run cli -- import corpus/staging/<run-id>
bun --filter ironqr-corpus-cli run cli -- build-bench
```

The publishable package documentation remains in `packages/ironqr/README.md`.
