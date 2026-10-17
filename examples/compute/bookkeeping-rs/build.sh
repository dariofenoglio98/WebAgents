#!/bin/sh
# Build the bookkeeping module reproducibly (compute.v0 example, D-243).
#
#   ./build.sh            # writes dist/bookkeeping.wasm and prints its SHA-256
#
# Needs rustup with the wasm32-unknown-unknown target:
#   rustup target add wasm32-unknown-unknown
# The lockfile pins every crate; the profile (Cargo.toml) is size-optimized with LTO, one
# codegen unit, panic=abort and symbols stripped; paths are remapped so the binary carries none
# of this machine. Two builds with the same rustc produce identical bytes; `README.md` records
# the rustc that built the committed binary and its SHA-256.
set -eu
cd "$(dirname "$0")"
# compute.v0 C-15: the memory must declare a maximum (the linker sets none by default); 256 pages
# (16 MiB) is ample for the bookkeeping of a review and is what the host checks its ceiling against.
export RUSTFLAGS="--remap-path-prefix=$PWD=/src --remap-path-prefix=$HOME/.cargo=/cargo -C link-arg=--max-memory=16777216"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/target}"
cargo build --release --target wasm32-unknown-unknown --locked --quiet
mkdir -p dist
cp "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/webagents_compute_example_bookkeeping.wasm" dist/bookkeeping.wasm
rustc --version
shasum -a 256 dist/bookkeeping.wasm
