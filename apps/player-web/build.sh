#!/usr/bin/env sh
# Build the browser player into OUT (default dist/player): the wasm module and its glue, the
# worker and the page-side library. No fonts are compiled in or shipped beside it except the
# last-resort face: each deck's fonts come from a font server (the `fontsBase` option).
# Needs: rustup target wasm32-unknown-unknown, wasm-bindgen-cli matching Cargo.lock, and
# wasm-opt (binaryen) on PATH or in WASM_OPT.
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${1:-$ROOT/dist/player}
WASM_OPT=${WASM_OPT:-wasm-opt}

TARGET=${CARGO_TARGET_DIR:-$ROOT/target}

cd "$ROOT"
# SIMD is in every browser the room supports (Chrome 91, Firefox 89, Safari 16.4).
RUSTFLAGS="${RUSTFLAGS:-} -C target-feature=+simd128" CRAFT_FONTS_EMBED=none \
  cargo build --release --target wasm32-unknown-unknown -p deckcraft-player-web --target-dir "$TARGET"
rm -rf "$OUT" && mkdir -p "$OUT"
wasm-bindgen --target no-modules --no-typescript --out-dir "$OUT" --out-name deckcraft_player \
  "$TARGET/wasm32-unknown-unknown/release/deckcraft_player_web.wasm"
"$WASM_OPT" -O3 --enable-simd --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
  --enable-mutable-globals --enable-reference-types --enable-multivalue \
  "$OUT/deckcraft_player_bg.wasm" -o "$OUT/deckcraft_player_bg.wasm"
cp apps/player-web/js/worker.js apps/player-web/js/player.js "$OUT/"
echo "built $OUT"
for f in "$OUT"/deckcraft_player_bg.wasm "$OUT"/deckcraft_player.js; do
  printf '%s: %s bytes, %s gzipped\n' "$(basename "$f")" "$(wc -c < "$f")" "$(gzip -9 -c "$f" | wc -c)"
done
