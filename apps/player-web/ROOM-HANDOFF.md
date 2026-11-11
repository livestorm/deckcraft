# Room handoff

What the webinar room has to do to adopt each version of `@livestorm/deckcraft-player`. The API is
documented in the package's README and at the top of `player.js` and `worker.js`.

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
