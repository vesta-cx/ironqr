# `@ironqr/wasm`

Experimental JS-facing boundary for the Rust wasm crate in
`rust/crates/ironqr-wasm`.

This package is intentionally thin in the first Turborepo slice. Its job is to
make the browser-facing dependency edge explicit before the wasm implementation
is fully wired.
