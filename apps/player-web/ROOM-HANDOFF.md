# Room handoff

What the webinar room has to do to adopt each version of `@livestorm/deckcraft-player`. The API is
documented in the package's README and at the top of `player.js` and `worker.js`.

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
