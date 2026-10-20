# @livestorm/deckcraft-player

The DeckCraft player built for the browser: a `.pptx` / `.ppsx` deck rendered by WebAssembly in a
Web Worker on an `OffscreenCanvas`, with the deck's audio and video played in the page's own
elements so they have sound. Built from [livestorm/deckcraft](https://github.com/livestorm/deckcraft),
`apps/player-web`.

| File | What it is |
| --- | --- |
| `worker.js` | The worker. Start it from a same-origin blob that calls `importScripts(<url of worker.js>)` |
| `deckcraft_player.js`, `deckcraft_player_bg.wasm` | The wasm-bindgen glue (`--target no-modules`) and the module the worker loads |
| `player.js` | A page-side library (ES module) driving the worker, with media overlays |
| `fonts/*.ttf`, `fonts.txt` | Metric-compatible stand-ins for Office fonts (Carlito, Caladea, Liberation; OFL, licences beside them) |

The worker's protocol is documented at the top of `worker.js`. The files are plain assets: serve
them as they are, or reference them with your bundler's URL import (Vite: `?url`).

The module needs WebAssembly SIMD (Chrome 91, Firefox 89, Safari 16.4).

Dual-licensed under MIT or Apache-2.0; the fonts are under the SIL Open Font License.
