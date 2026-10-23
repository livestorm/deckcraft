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

The worker's protocol is documented at the top of `worker.js`. The files are plain assets: serve
them as they are from one folder and pass it as `base`, or let your bundler give each its own URL
and pass those:

```js
import { DeckcraftPlayer } from '@livestorm/deckcraft-player/player.js'
import workerUrl from '@livestorm/deckcraft-player/worker.js?url'
import glueUrl from '@livestorm/deckcraft-player/deckcraft_player.js?url'
import wasmUrl from '@livestorm/deckcraft-player/deckcraft_player_bg.wasm?url'

const player = new DeckcraftPlayer(container, { workerUrl, glueUrl, wasmUrl, fontsBase: FONTS_CDN })
player.on('fonts', ({ loaded, missing }) => console.log(loaded, missing))
await player.open(deckUrl)
```

## Fonts

Only one font is compiled in, a last resort so text always shows. Pass `fontsBase`, the fonts CDN
of entropy's `packages/fonts` (Google Fonts, every weight and character set). Opening a deck then
downloads just the fonts it uses, before its first slide is drawn:

- fonts the deck embeds are used as they are;
- a family on the server is fetched by name, in the weights and styles the deck uses
  ("Montserrat Light" is Montserrat's 300 face);
- Office fonts get their open stand-ins with the same widths (Calibri: Carlito, Cambria: Caladea,
  Arial: Arimo, Times New Roman: Tinos, Courier New: Cousine, Aptos: Inter);
- anything else is drawn in Arimo, Tinos or Cousine, chosen from what the file says the font is
  (sans, serif or monospace);
- text in a script those don't cover gets a face for it: BIZ UDPGothic for Japanese and Chinese,
  Nanum Gothic for Korean, Noto for Arabic, Hebrew, the Indic scripts, Thai, Khmer and the rest.
  Chinese draws with Japanese glyph shapes: Google's Chinese faces are Noto CJK (Source Han
  renamed), which DeckCraft doesn't use, nor Adobe's Source families, even when a deck names them;
- at most 64 fonts per deck, 6 downloads at a time.

The `fonts` event lists what was loaded and the families that found nothing. You can still pass
font files of your own as `fonts: [url]`; they load before any deck.

The module needs WebAssembly SIMD (Chrome 91, Firefox 89, Safari 16.4).

Dual-licensed under MIT or Apache-2.0. The compiled-in last-resort face is Ubuntu Light (Ubuntu
Font Licence 1.0).
