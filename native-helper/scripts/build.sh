#!/bin/bash
# Build the helper as one universal binary (T17, D-201): release builds for arm64 and x86_64
# (macOS 12+), joined with lipo, ad-hoc signed under the identifier org.webagents.helper (U8
# replaces this with a Developer ID). Output: native-helper/dist/webagents-helper.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"
for arch in arm64 x86_64; do
  swift build -c release --triple "$arch-apple-macosx12.0" --scratch-path ".build/$arch" >&2
done
mkdir -p dist
lipo -create -output dist/webagents-helper .build/arm64/release/webagents-helper .build/x86_64/release/webagents-helper
codesign --force --sign - --identifier org.webagents.helper dist/webagents-helper
codesign --verify --strict dist/webagents-helper
lipo -info dist/webagents-helper >&2
echo "$here/dist/webagents-helper"
