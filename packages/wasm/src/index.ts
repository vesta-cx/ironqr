export const WASM_CRATE_DIRECTORY = 'rust/crates/ironqr-wasm';

export const loadIronqrWasm = async () => {
  throw new Error(
    `The wasm bridge is not wired yet. Build the Rust crate at ${WASM_CRATE_DIRECTORY} first.`,
  );
};
