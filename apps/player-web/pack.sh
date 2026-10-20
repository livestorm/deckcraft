#!/usr/bin/env sh
# Build the npm package @livestorm/deckcraft-player into OUT (default dist/player-npm): build.sh's
# output plus npm/package.json, npm/README.md and the licences. Publish with `npm publish OUT`.
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${1:-$ROOT/dist/player-npm}
sh "$ROOT/apps/player-web/build.sh" "$OUT"
cp "$ROOT/apps/player-web/npm/package.json" "$ROOT/apps/player-web/npm/README.md" "$OUT/"
cp "$ROOT/LICENSE-MIT" "$ROOT/LICENSE-APACHE" "$OUT/"
echo "packed $OUT ($(node -p "require('$OUT/package.json').version"))"
