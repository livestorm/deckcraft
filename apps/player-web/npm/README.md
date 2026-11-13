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
player.advance(player.nextOf(player.position)) // a click: the next step or slide, animated
player.advance(player.prevOf(player.position)) // Back: to the previous slide, its transition reversed
player.jump(position)                           // anything else, shown at rest
player.on('link', e => console.log(e.target))   // a click on a link in the deck (see Links)
```

## Fonts

Only one font is compiled in, a last resort so text always shows. Pass `fontsBase`, the URL of a
font server: a Google Fonts mirror with every weight and character set, one folder per family.
Opening a deck then downloads just the fonts it uses, before its first slide is drawn:

- fonts the deck embeds are used as they are;
- a family on the server is fetched by name, in the weights and styles the deck uses
  ("Montserrat Light" is Montserrat's 300 face);
- Office fonts get their open stand-ins with the same widths (Calibri: Carlito, Cambria: Caladea,
  Arial: Arimo, Times New Roman: Tinos, Courier New: Cousine, Aptos: Inter);
- anything else is drawn in Arimo, Tinos or Cousine, chosen from what the file says the font is
  (sans, serif or monospace);
- text in a script those don't cover gets a face for it: BIZ UDPGothic for Japanese and Chinese,
  Nanum Gothic for Korean, Bpmf Huninn for Bopomofo, Noto for Arabic, Hebrew, the Indic scripts,
  Thai, Khmer and the rest.
  Chinese draws with Japanese glyph shapes: Google's Chinese faces are Noto CJK (Source Han
  renamed), which DeckCraft doesn't use, nor Adobe's Source families, even when a deck names them;
- at most 64 fonts per deck, 6 downloads at a time.

### Font server layout

```
<fontsBase>families/<key>/family.json
<fontsBase>families/<key>/<file>
```

`<key>` is the family name lowercased with spaces as hyphens (`Open Sans` → `open-sans`).
`family.json` lists the family's faces as TrueType files:

```json
{
  "family": "Open Sans",
  "category": "sans-serif",
  "faces": [
    { "weight": 400, "italic": false, "file": "open-sans-400.ttf" },
    { "weight": 700, "italic": true, "file": "open-sans-700italic.ttf" }
  ]
}
```

Any error response means the family isn't there. The server must send CORS headers
(`Access-Control-Allow-Origin`) for the pages the player runs on.

The `fonts` event lists what was loaded and the families that found nothing. You can still pass
font files of your own as `fonts: [url]`; they load before any deck.

## Pictures fetched from a URL

A deck can name pictures whose bytes live outside it: PowerPoint writes them for Insert > Picture >
Link to File, and a media service can take large pictures out of the copy viewers download and link
them instead, as it does for large videos. The player draws them once it has their bytes.

**It never fetches a URL just because a deck names one.** Pass `mediaBase`, the `https` URL prefix
the pictures may come from — the path the decks themselves are served from:

```js
const player = new DeckcraftPlayer(container, { mediaBase: MEDIA_CDN, mediaCredentials: 'include' })
player.on('images', ({ loaded, failed, bytes, ms, slides }) => console.log(loaded, failed))
player.on('error', e => { if (e.message === 'image-unavailable') console.warn(e.url, e.reason) })
```

- Without `mediaBase`, nothing is ever fetched, whatever a deck names.
- A picture is fetched only if its URL is `https`, on `mediaBase`'s own origin and under its path,
  with no user name or password, no `..` (encoded or not), no encoded separator, backslash, space
  or control character, and no more than 2048 characters. Everything else is left alone and draws
  nothing, `file:` paths above all: Link to File writes a local path, which is not the viewer's.
  The rule is applied by the module and again by the worker, and redirects are never followed:
  a redirect fails the picture, so a URL under `mediaBase` can't send the browser elsewhere.
- `mediaCredentials` is the fetch credentials mode for pictures (`'include'`, `'same-origin'`,
  `'omit'`). Unset, a picture is fetched like the deck itself, `fetch(url)`, whose default mode
  sends cookies only to the page's own origin. A cross-origin path serving them must send CORS
  headers, plus `Access-Control-Allow-Credentials: true` for `'include'`.
- The slide the deck opens on has its pictures before the first frame; the rest follow, and the
  slide on screen is drawn again as they arrive. At most 4 fetches at once, 20 s each, 32 MB per
  picture, 256 MB and 512 pictures per deck.
- A picture that can't be fetched, or whose bytes aren't a picture this player draws, gives `error`
  with `{message: 'image-unavailable', url, slide, reason, fatal: false}`; the deck plays on and it
  never fails `open()`. Its box draws as an empty picture (a light grey rectangle with a cross), as
  any picture whose bytes can't be read does.
- `images({loaded, failed, bytes, ms, slides})` reports each round, and `metrics` carries the same
  counts as `imagesLoaded`, `imagesFailed`, `imageBytes` and `imageMs`.

Worker protocol: `mediaBase` and `mediaCredentials` are `init` options; the worker sends
`{type: 'images', loaded, failed, bytes, ms, slides}` per round and
`{type: 'error', message: 'image-unavailable', url, slide, reason, fatal: false}` per failure.

## Speaker notes for presenters

Attendees should open a copy of the deck without its speaker notes. Hidden slides are removed from
that copy too, so a slide's index can differ between the copy and the original. Every slide keeps
its id from the file (`p:sldId id`), which `info.slides[].fileId` reports.

A presenter opens the copy like everyone else, so positions stay in step, and reads the original's
notes on the side:

```js
const notes = await player.notesOf(originalUrl)   // Map of file slide id → notes (plain text)
const slide = player.info.slides.find(s => s.index === player.position[0])
showNotes(notes.get(slide.fileId) ?? '')
```

`notesOf` reads the original in the worker without touching the deck on screen. A newer call
replaces a pending one; it rejects if the original can't be read. Keep the notes in the presenter's
browser: don't send them to other people through your own sync.

Worker protocol: send `{type: 'notes', url}`; the worker answers `{type: 'notes', notes: [{fileId,
notes}]}` or `{type: 'notesError', message}`.

## Keeping media in step

With `controls`, a presenter's play, pause or seek in a clip's controls is sent as
`mediaAction({shape, action, at, time})`: the clip plays or pauses `at` seconds in, as of `time` on
the player's `clock`. Pass each one to `player.mediaAction(a)` on every client, the presenter's
included, and keep the latest one per clip to give someone who joins:

- a playing clip starts where it has got to since `time`, so a late message or a newcomer lands
  where everyone else is (a looping clip goes round its loop; one that would have ended stays put);
- every second, a playing clip that has drifted is brought back: a video or audio clip up to a
  second off plays 5% faster or slower until it is back, and one further off jumps. YouTube's speed
  can't be nudged, so a YouTube video jumps when more than a second off;
- leaving the slide forgets the clip's action; a media effect on the deck's timeline starts it
  afresh on each client.

`clock` (an option, or `player.clock = fn`) gives the time in milliseconds that every client
shares. It is `Date.now` by default, which is only as close as the computers' clocks; give it the
server's time, as each client last measured its offset from it, for viewers to keep within a
fraction of a second. An action without `time` (from players before 0.5.0) is followed as before,
and not kept in step.

## Links

Links in a deck can be clicked: on a whole shape or picture (Insert > Link on the shape, or an
action), and on runs of text, one box per line a run is laid out on. As in PowerPoint's slide
show, only what is shown at the current step can be clicked (a shape not yet animated in, or gone,
can't), the topmost shape under the pointer decides, a shape without a link blocks the links
beneath it, and groups, rotation and flips are followed.

```js
player.on('link', e => {
  // e.target: {type: 'url', url} | {type: 'slide', index, fileId} |
  //           {type: 'nextSlide' | 'previousSlide' | 'firstSlide' | 'lastSlide' | 'endShow'}
  // e.position: where a slide target goes ([slide, step]), null when nowhere in this show
  // e.moves: the player moves there itself (a slide target, with `controls`)
  // e.shape, e.text (a link on text), e.label, e.tooltip
  // e.preventDefault(): the player then does nothing more
})
player.links            // the current position's links: [{target, shape, text, rect, quad, tooltip, label}]
await player.linkAt(x, y) // the link a click at (x, y) follows, or null
```

- The pointer turns into a hand over a link that does something for this viewer: a URL, or with
  `controls` a slide target. Hit tests run in the worker only over a link's box, at most every
  `linkHoverMs` (100 ms by default).
- A click on a link emits `link` and is stopped there: the page's own click handlers on the player
  don't see it, so a click that advances the slide doesn't. A click elsewhere is the page's, as
  before.
- Unless the page calls `preventDefault()`: a URL opens in a new tab with `noopener,noreferrer`;
  with `controls`, a slide target moves the deck like `advance(e.position)` (the next slide's
  transition plays when it is one click ahead). Without `controls`, slide targets are only
  reported. `endShow` is left to the page.
- Only `http` and `https` (with a host), `mailto` and `tel` URLs are kept, by the worker and again
  by the page: `javascript:`, `data:`, `file:`, relative and malformed links are dropped. A slide
  target is kept only for a slide of this show: a link to a slide the attendee copy left out (a
  hidden slide) is dropped. Links to the last slide viewed, custom shows, programs and media aren't
  followed; links in the layout's and master's graphics aren't either, as in DeckCraft's own show.
- Each link the viewer can use gets a transparent `<a>` over it, labelled by its linked text or the
  shape's alternative text, else its ScreenTip, with where it goes. Keyboards and screen readers
  reach them (a link over several lines once, at its first line); the mouse goes through them to
  the slide.
- Clips' own controls (`controls`) sit above the links and get their clicks, as before.

`rect` is `[x, y, w, h]` and `quad` the box's corners as turned (`[[x, y] × 4]`), both in fractions
of the slide. At most 256 links per position; labels and ScreenTips are cut to 200 characters,
URLs to 2048.

Worker protocol: the worker sends `{type: 'links', slide, step, links}` after `ready` and whenever
the position changes. Send `{type: 'linkAt', id, x, y}`; the worker answers `{type: 'linkAt', id,
link}` (`null` when there is none) at once, outside its queue.

## YouTube videos

A YouTube video inserted in PowerPoint (Insert > Video > Online Video) plays in YouTube's own
player over the slide, in privacy-enhanced mode (`www.youtube-nocookie.com`). It follows the deck's
media effects and `mediaAction` like any clip: with `controls`, YouTube's controls report plays,
pauses and seeks as `mediaAction`, and everyone else's player follows. (A seek is sent as the clip's
`play` or `pause` at its new time, for any clip, so players before 0.4.1 follow it too.) A start or
end time in the link
(`?start=`, `?t=1m30s`, `?end=`) bounds the clip.

YouTube's script loads only for a deck with a YouTube video, and each video's player is made the
first time its slide shows. The page must allow `script-src https://www.youtube.com` and
`frame-src https://www.youtube-nocookie.com`. A video that can't play (YouTube blocked, embedding
disabled, video removed) gives `error` with `{message: 'video-unavailable', fatal: false}`, and its
poster stays on the slide. Each viewer streams from YouTube, and YouTube may show them ads: a video
playing from a media action is brought back to the others within about a second once it plays
again. Other online video services show their poster.

The module needs WebAssembly SIMD (Chrome 91, Firefox 89, Safari 16.4).

Dual-licensed under MIT or Apache-2.0. The compiled-in last-resort face is Ubuntu Light (Ubuntu
Font Licence 1.0).
