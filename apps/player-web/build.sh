#!/usr/bin/env sh
# Build the browser player into OUT (default dist/player): the wasm module and its glue, the
# worker, the page-side library, and the stand-in fonts for Office's (OFL, from craft-fonts).
# Needs: rustup target wasm32-unknown-unknown, wasm-bindgen-cli matching Cargo.lock, wasm-opt
# (binaryen) on PATH or in WASM_OPT, and craft-fonts at CRAFT_FONTS_DIR (default ../craft-fonts).
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${1:-$ROOT/dist/player}
FONTS=${CRAFT_FONTS_DIR:-$ROOT/../craft-fonts}
WASM_OPT=${WASM_OPT:-wasm-opt}

TARGET=${CARGO_TARGET_DIR:-$ROOT/target}

cd "$ROOT"
# SIMD is in every browser the room supports (Chrome 91, Firefox 89, Safari 16.4).
RUSTFLAGS="${RUSTFLAGS:-} -C target-feature=+simd128" \
  cargo build --release --target wasm32-unknown-unknown -p deckcraft-player-web --target-dir "$TARGET"
rm -rf "$OUT" && mkdir -p "$OUT/fonts"
wasm-bindgen --target no-modules --no-typescript --out-dir "$OUT" --out-name deckcraft_player \
  "$TARGET/wasm32-unknown-unknown/release/deckcraft_player_web.wasm"
"$WASM_OPT" -O3 --enable-simd --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
  --enable-mutable-globals --enable-reference-types --enable-multivalue \
  "$OUT/deckcraft_player_bg.wasm" -o "$OUT/deckcraft_player_bg.wasm"
cp apps/player-web/js/worker.js apps/player-web/js/player.js "$OUT/"
for family in carlito caladea liberation-sans liberation-serif liberation-mono; do
  cp "$FONTS/fonts/$family"/*.ttf "$OUT/fonts/"
  cp "$FONTS/fonts/$family/OFL.txt" "$OUT/fonts/$family-OFL.txt"
done
ls "$OUT/fonts"/*.ttf | sed "s|$OUT/||" > "$OUT/fonts.txt"
echo "built $OUT"
for f in "$OUT"/deckcraft_player_bg.wasm "$OUT"/deckcraft_player.js; do
  printf '%s: %s bytes, %s gzipped\n' "$(basename "$f")" "$(wc -c < "$f")" "$(gzip -9 -c "$f" | wc -c)"
done
printf 'fonts: %s bytes, %s gzipped\n' "$(cat "$OUT"/fonts/*.ttf | wc -c)" "$(cat "$OUT"/fonts/*.ttf | gzip -9 -c | wc -c)"
