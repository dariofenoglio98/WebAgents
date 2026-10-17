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
export RUSTFLAGS="--remap-path-prefix=$PWD=/src --remap-path-prefix=$HOME/.cargo=/cargo"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/target}"
cargo build --release --target wasm32-unknown-unknown --locked --quiet
mkdir -p dist
cp "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/webagents_compute_example_bookkeeping.wasm" dist/bookkeeping.wasm
rustc --version
shasum -a 256 dist/bookkeeping.wasm
