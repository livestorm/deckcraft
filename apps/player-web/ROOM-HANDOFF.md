# Room handoff

What the webinar room has to do to adopt each version of `@livestorm/deckcraft-player`. The API is
documented in the package's README and at the top of `player.js` and `worker.js`.

## Unreleased: a clip's volume and Mute kept apart

Draft for the next release (merged into its section when the version is set).

A customer reported that the sound button on videos did nothing until the volume slider was moved,
and that a slide's video was locked on mute. The deck's video was muted in PowerPoint, which saved
it as volume 0 (`vol="0"`). 0.12.0 gave the room that volume of 0 (and read the `mute` attribute
as 0 too), so the native mute button unmuted a clip still at volume 0. Separately, a presenter's volume and mute changes reach no one
else, so attendees, who have no controls, can never hear a clip that starts muted.

**What changes in the package:**

- The worker's `ready` message, `{type: 'ready', info, media, openMs}`, gives each clip in `media`
  a new `muted: boolean` beside `volume`. `volume` (0–1) is now the deck's real level, kept while
  muted. The rule: `muted` is true when the deck says `mute="1"` or its volume is 0 (how PowerPoint
  saves Mute); a muted clip whose deck volume is 0 or absent gets `volume: 1`; any other volume, low
  ones included (0.08 is the author's choice), is passed as it is, unmuted. `volume` is never 0.
- The same rule for the current 0.12.0 player, which has no `muted`: treat `volume === 0` as
  `muted: true, volume: 1`.
- `YouTubeClip` (exported from `player.js`) has a `muted` property: setting it mutes or unmutes
  YouTube's player, now or once it is ready.
- `player.js`'s own `DeckcraftPlayer` (not the room's) applies `muted`, and sends and applies a
  presenter's sound in `mediaAction({shape, action, at, time, volume, muted})`. Its `report`,
  `setSound` and `mediaAction` show one way to do the same in the room; the README's "Keeping media
  in step" describes it.

**What to change in the room** (`deckcraft-player.ts` has its own media layer):

1. Bump `@livestorm/deckcraft-player` to the release with this change.
2. In `buildMedia`, set both: `el.volume = clamp(c.volume ?? 1)` and `el.muted = !!c.muted`. That
   alone fixes the dead mute button.
3. Send a presenter's volume and mute changes (the element's `volumechange`, not the player's own
   changes) with play and pause, and apply received ones on every viewer. Extend `MediaAction` with
   optional `volume` and `muted`; send a change as the clip's current `play` or `pause` at its
   current time, so players that ignore the new fields just keep in step. A volume slider drag
   fires many `volumechange` events: send once it rests.
4. Late joiners get the clip's sound from the latest stored action: check that Rails
   (`RoomChannel#manage_media`, `medias_params["powerpoint"]["clips"]`) keeps `volume` and `muted`.
5. Keep the sound-blocked flow: a browser that won't unmute a playing clip before the viewer has
   clicked pauses it instead. Treat that as blocked sound (`resumeSound`), and don't send that pause
   as the presenter's.

## Unreleased: media actions say what made them, and only the slide shown sends them

Draft for the next release (merged into its section when the version is set).

A customer's webinar with two presenters (the organiser and a speaker) had slides with videos
switch between slides 3 and 4 on their own. Each presenter's player sends `mediaAction`, and the
room sends each one as an update with **that presenter's** slide and step. Some of those actions
were not a presenter's doing:

- **A clip reaching its end.** The browser pauses a clip at its end (a `pause` event, then
  `ended`), and the player sent that pause like a presenter's. Both presenters' clips end at about
  the same moment; if one has just moved to slide 4, the other's end still says slide 3, and the
  room goes back.
- **The player's own seek, seconds late.** The player keeps clips in step by seeking them, and
  rewinds them for media effects and loops. It recognised the `seeked` of its own seek for 3 s
  only, and only at the exact time. A large video seeking on a slow network answers later, or after
  playing on, and was sent as a presenter's seek.

Now:

- Each `mediaAction` carries `trigger`: `controls` (a play, pause, volume or mute change in the
  clip's controls), `seek` (a seek in them) or `ended` (the clip got to its end by itself), and
  `slide`, the clip's slide. `shape`, `action`, `at`, `time`, `volume` and `muted` are as before.
- A clip's end is sent with `trigger: 'ended'`, still as a pause at the end, so someone who joins
  later sees it stopped there.
- The player's own seek is recognised for 15 s, by where it went.
- `player.mediaAction(a)` applies an action with `slide` only to that slide's clip: shape ids are
  unique only within a slide.
- A clip on a slide no longer shown sends nothing. Its controls are hidden, so nothing it does
  there is a presenter's.
- Media effects, trims, loops and keeping in step were never sent, and still aren't.

**What the room must change.** A media action must not move the deck:

- Send it with the clip's state only: no slide and step, or fields the server applies without
  changing the room's slide and step. Only Next, Back, the keyboard, a link to a slide and a jump
  move the deck.
- Keep storing the latest action per clip (`medias_params["powerpoint"]["clips"]`) for people who
  join. `ended` is stored like the others.
- Optionally, drop an action whose `slide` isn't the room's current slide.

Without the room change, this version stops the late-seek and off-slide sends, but a clip's end
still reaches the room as a pause from both presenters, and the room still moves to the sender's
position. Ship both together.

## Unreleased: why a linked picture is missing, and retries for passing failures

Draft for the next release (merged into its section when the version is set).

Every upload of one customer's deck in November logged `Deck media unavailable` for linked (CDN)
pictures. Morpheus's pictures decode, so they failed while being fetched, but the room's event
doesn't say why. 0.12.0 already sends a `reason` and a `slide` with each failure; the room drops
them. And a picture that failed once, even with one timeout behind a slow CDN response, was never
fetched again for the rest of the webinar: a box with a cross on its slide until the page reloaded.

**What changes in the package:**

- `image-unavailable` keeps every 0.12.0 field (`url`, `slide`, `reason`, `fatal`; `reason` is
  unchanged) and adds:

  | Field | Value |
  |---|---|
  | `code` | `'http'` \| `'timeout'` \| `'network'` \| `'too-large'` \| `'deck-budget'` \| `'undecodable'` \| `'unknown'` |
  | `status` | the HTTP status for `'http'`, else `null` |
  | `file` | the last segment of the URL's path, e.g. `'image31.jpg'` |
  | `media` | the player's id for the picture |
  | `slides` | every slide (index) that draws it; `slide` stays the first of them |
  | `onScreen` | the slide on screen when it failed |
  | `retry` | `true` if a later move fetches it again, `false` once it is given up |
  | `ms` | milliseconds from its request to the failure |

  `'network'` is every failure without an answer: a CORS refusal (a 403 without
  `Access-Control-Allow-Origin` included), a lost connection, a redirect (never followed) and an
  offline browser. A page can't tell these apart; the CDN's logs, or DevTools on an affected
  machine, can.
- A picture that failed with `'timeout'`, `'network'` or a 5xx status is fetched again when a later
  move brings its window back, never in the move it failed in, at most twice more (three requests
  in a row), through the same queue of at most 4 fetches. A picture that loads starts afresh: if it
  fails again later, it gets two more retries. A 4xx, `'too-large'` and `'undecodable'`
  are never retried; `'deck-budget'` is tried again on every later move, as before. A failure is
  reported each time, so one picture can give up to three events, the last with `retry: false`.

**What to change in the room:**

1. Bump `@livestorm/deckcraft-player` to the release with this change.
2. Add to `Deck media unavailable` (source `linked_image`): `code`, `status`, `retry`, `file`,
   `slide`, `onScreen` and `ms`. Leave out `url` if it is signed. Count a picture as lost only on
   `retry: false`.

## 0.12.0: embedded fonts drawn, Line Color and Font Color animations fixed

PowerPoint compresses the fonts it embeds in a deck (MicroType Express), and 0.11.0 could not read
them: text in an embedded face drew in a stand-in, or in whatever the font server had under that
name. A brand face that is not on the font server, as in a customer's webinar deck, always drew in
a stand-in. Now embedded faces are decompressed and drawn, TrueType and CFF-flavoured OpenType
alike.

**Nothing to change in the room** beyond the version. Options, events and messages are the same.

**What the room sees:**

- Text in a face the deck embeds draws in that face. The player no longer asks the font server
  (`fontsBase`) for those families, so `fonts` lists them in neither `loaded` nor `missing`, and a
  deck that embeds all its faces makes no font requests at all.
- Opening a deck that embeds fonts takes longer: each embedded face is decompressed before the
  first frame. A deck embedding 25 faces opened in about 1.0 s instead of 0.4 s in Chromium.
- Line Color and Font Color animations recolour the outline and the text. They used to fill the
  shape instead: a Font Color step on a text box with no fill drew a solid box behind text that
  kept its colour. Font Color by paragraph, which changed nothing, now recolours each paragraph.
  Colour changes start from the colour drawn, so nothing jumps when one begins.

## 0.11.0: linked pictures released as their slides move away

0.10.0 fetches pictures by window but never lets go of one, and caps a deck at 256 MB of linked
pictures ever fetched. A deck of 4K photographs (about 5.5 MB each) stops drawing pictures from
about slide 46 (`deck-budget` errors, empty boxes). Now the player holds only the pictures of the
slides near the one on screen, so a deck can link any number of them.

**Nothing to change in the room** beyond the version. Options, events and messages are the same.
Morpheus can then drop its per-deck cap on linked pictures (`maxLinkedPicturesSize`), keeping the
32 MB per-picture limit; release that together with this bump.

**What the room sees:**

- On every move the player releases the pictures no slide near the one on screen draws: near is
  the window (that slide, the next two and the previous one) and one slide more each side. A
  picture several slides share stays while any of them is near. The 256 MB cap is now on what is
  held at once: with one 4K photograph per slide that is about 33 MB (six slides).
- A released picture is fetched again when its window comes back, so moving back over slides seen
  earlier fetches their pictures again (the CDN serves them; nothing is cached by the player).
  Stepping back and forth one slide never fetches one again. `images` counts each fetch, so its
  `loaded` and `bytes` can add up to more than the deck links.
- A failed picture is still not tried again, except one refused for the 256 MB cap
  (`deck-budget`), which now only a window of more than 256 MB of pictures reaches; it is tried
  again on a later move.
- A picture whose slides all left the window while it was downloading (a fast skip ahead) is
  dropped when it arrives and not counted in `images`.
- A picture refused for its size from its `Content-Length` no longer leaves its connection open.
  In 0.10.0 each such refusal held one of the browser's few connections to the CDN, so after a
  handful every later picture timed out.

## 0.10.0: linked pictures fetched as their slides come near

0.9.0 fetches every linked picture of a deck right after the first frame, whichever slides a viewer
sees. Now each viewer fetches only what they are about to see.

**Nothing to change in the room** beyond the version (and the `pnpm-workspace.yaml`
minimum-release-age exemption, as for 0.9.0). Options, events and messages are the same.

**What the room sees:**

- The slide the deck opens on still has its pictures before the first frame. Then the player
  fetches the window of the slide on screen: that slide, the next two and the previous one, in the
  show's order. Every move (Next, Back, a jump, a link) fetches the new window's pictures that
  haven't been fetched or tried yet, the slide on screen's first. A picture used on several slides
  is fetched once, and one that failed is not tried again.
- **The cost: after a jump far away, the slide shows briefly without its pictures** (their boxes
  draw as empty pictures) until they arrive, then it is drawn again. Moving one slide at a time
  never shows this once the window has loaded, since the next two slides' pictures are already in.
- `images` comes more often: once for the opening slide, then once per move that brought new
  pictures, each with only that round's counts. The room already adds them up.
- A late joiner who lands on slide 20 still fetches the first slide's pictures before `ready`, as
  0.9.0 did: `open()` doesn't know where the room will jump. Their window then follows the jump.

## 0.9.0: pictures fetched from a URL

The player can draw pictures whose bytes live outside the deck (linked pictures): the deck names a
URL, and the player fetches it. Nothing changes until Morpheus starts taking large images out of
the copy attendees download, as it already does for large videos; this version is what makes that
possible.

**The room must pass `mediaBase`** for any linked picture to be drawn; `mediaCredentials` only if
those pictures need cookies the deck's own download doesn't carry:

- `mediaBase`: the `https` URL prefix linked pictures may be fetched from, the path the deck itself
  is served from. Only pictures under it are fetched, after normalising: another origin, `http`, a
  user name or password, `..` or an encoded separator is never requested, and neither is a `file:`
  path, which PowerPoint's own Insert > Picture > Link to File writes. **Without `mediaBase`
  nothing is ever fetched**, whatever a deck names: that is 0.8.0's behaviour, so a room that
  passes nothing keeps it.
- `mediaCredentials`, the fetch credentials mode for pictures. Unset, a picture is fetched exactly
  as the deck is: `fetch(url)`, whose default mode (`same-origin`) sends cookies only when the URL
  is the room's own origin. **Check this before shipping:** if the decks are served from a path
  whose cookies are not the room's own origin's, the deck download has never carried them either,
  so that path is reached some other way today (a signed URL, or a path proxied through the room's
  origin), and pictures under it are reached the same way with no option at all.
  Pass `mediaCredentials: 'include'` only if the pictures genuinely need cross-origin cookies; the
  path must then send `Access-Control-Allow-Credentials: true` and name the room's origin.

**What the room sees:**

- Pictures for the slide the deck opens on are fetched before the first frame, so the audience
  never sees that slide without them; the rest follow, and the slide on screen is drawn again as
  they arrive. Nothing changes for a deck without linked pictures.
- `images({loaded, failed, bytes, ms, slides})` after each round, and the same counts in `metrics`
  (`imagesLoaded`, `imagesFailed`, `imageBytes`, `imageMs`).
- A picture that can't be fetched or drawn gives `error` with `{message: 'image-unavailable', url,
  slide, reason, fatal: false}`. It never fails `open()`, and the rest of the slide draws as usual.
  **Its box is drawn as an empty picture** — a light grey rectangle with a grey cross, which is
  what the player has always drawn for a picture whose bytes it can't read, linked pictures
  included. If the room would rather such a picture left the slide's background showing, say so:
  it is a change to the renderer, not to this release.
- At most 4 picture fetches at once, 20 s each, 32 MB per picture and 256 MB per deck.

**To check before shipping:**

- The room's Content Security Policy must allow `connect-src` to the host serving the pictures:
  the worker fetches them with `fetch`, as it does the deck.
- The path serving the pictures must answer with the picture itself, not a redirect: redirects
  are refused, so a URL under `mediaBase` can never lead elsewhere.
- The path serving the pictures must send CORS headers (`Access-Control-Allow-Origin` for the
  room's origin, plus `Access-Control-Allow-Credentials: true` with `mediaCredentials: 'include'`).
- Lazy loading (fetching later slides' pictures only when they are near) and shrinking pictures are
  later versions: 0.9.0 fetches every linked picture of the deck.

## 0.8.0: links in slides

Attendees can click web links in a deck; presenters can also follow links between slides. Before
this version, links in slides did nothing in the room.

**Nothing changes in the deck pipeline.** The attendee copy (notes and hidden slides removed) keeps
web links and links to slides. Links to hidden slides point at slides the copy doesn't have; the
player drops them.

**Attendees** (no `controls`):

- Web, mail and phone links work with no code: the pointer turns into a hand, and a click opens the
  link in a new tab (`noopener,noreferrer`).
- Links between slides do nothing for them: no hand, no anchor. A click on one emits `link` with
  `moves: false` and is otherwise ignored.
- A click on a link no longer reaches the room's own click handlers on the player. If the room
  advances on a click on the slide, that is what keeps a link click from also advancing.

**Presenters** (`controls: true`):

- Web links open as for attendees. Opening a link is local: it is never sent to anyone.
- A link to a slide (or Next, Previous, First, Last) moves the presenter's player itself. The room
  must send the new position to attendees as it does for Next and Previous: on `link` with
  `e.moves`, send `e.position` (or read `player.position` after it). Alternatively, call
  `e.preventDefault()` and move the deck the room's own way with `player.advance(e.position)`.
- `endShow` is reported and nothing else: end the presentation in the room's own way, or ignore it.

**To check before shipping:**

- The room's Content Security Policy doesn't need to change: links open in a new tab.
- If the room wants to confirm before leaving for another site, handle `link` for `url` targets,
  call `e.preventDefault()` and open the link itself after asking.
- If the room listens for clicks on the player in the capture phase, those listeners still see link
  clicks before the player does: listen in the bubble phase instead.
