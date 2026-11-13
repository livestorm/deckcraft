// Page side of the DeckCraft player: a canvas drawn by the worker, plus the deck's audio and video
// played in the browser's own elements over it, so they have sound.
//
//   const p = new DeckcraftPlayer(container, { base: '/deckcraft/0.1.0/', fonts: [...] })
// `base` holds worker.js, deckcraft_player.js and deckcraft_player_bg.wasm. When a bundler gives
// them their own (hashed) URLs, pass those instead: { workerUrl, glueUrl, wasmUrl, fonts }.
// `fontsBase` is a font server (a Google Fonts mirror): each deck then downloads just the
// fonts it uses, before its first slide is drawn. `fonts` are added up front either way.
// `mediaBase` is the https URL prefix the deck's linked pictures (pictures whose bytes live
// outside it) may be fetched from; without it none are ever fetched, whatever a deck names.
// `mediaCredentials` is the fetch credentials mode for them; unset, a picture is fetched like the
// deck itself, fetch(url), which sends cookies only to the page's own origin.
//   await p.open(url)
//   p.advance(p.nextOf(p.position)) // a click
//   p.advance(p.prevOf(p.position)) // Back: to the previous slide, its transition plays reversed
//   p.jump(pos)                     // a jump, at rest
//   await p.notesOf(originalUrl)    // presenters: Map of file slide id → notes of another deck;
//                                   // the current slide's is info.slides[k].fileId
//
// Events (p.on(name, fn)): ready(info), state({slide, step, animating}), metrics(m), error(err),
// fonts({loaded: [{family, from}], missing: [family]}) with fontsBase,
// images({loaded, failed, bytes, ms, slides}) per round of linked-picture fetches with mediaBase
// (the starting slide's first, then the rest). A picture that can't be fetched or drawn gives
// error({message: 'image-unavailable', url, slide, reason, fatal: false}); the deck plays on, and
// its box draws as an empty picture, as any picture whose bytes can't be read does,
// mediaAction({shape, action, at, time}) when someone with controls plays, pauses or seeks a clip
// themselves; `time` is when, on `clock`. Pass every media action to p.mediaAction(a) on every
// client, and hand the latest one per clip to someone joining: playing clips keep to it.
// `clock` gives the time in ms that all clients share, best the server's: Date.now by default.
// A YouTube video (PowerPoint's online video) plays in YouTube's player, in privacy-enhanced mode;
// one that can't play gives error({message: 'video-unavailable', fatal: false}).
//
// Links in the deck: the pointer turns into a hand over a link that does something for this viewer,
// and a click on one emits link(e) instead of reaching the page's own click handlers:
//   e.target: {type: 'url', url} (http, https, mailto or tel only), {type: 'slide', index,
//     fileId}, or {type: 'nextSlide' | 'previousSlide' | 'firstSlide' | 'lastSlide' | 'endShow'}
//   e.position: where a slide target goes ([slide, step]), null when nowhere in this show
//   e.moves: the player moves there itself (a slide target, with `controls`)
//   e.shape, e.text, e.label, e.tooltip; e.preventDefault() stops what follows
// Then, unless prevented, a URL opens in a new tab (noopener, noreferrer) and, with `controls`, a
// slide target moves the deck like advance(e.position). Without `controls` a slide target is only
// reported. endShow is left to the page. Each link also gets a transparent, focusable, labelled
// <a> over it, so keyboards and screen readers reach it (slide targets with `controls` only).
// p.links holds the current slide's links ({target, shape, text, rect, quad, tooltip, label}, in
// fractions of the slide); p.linkAt(x, y) resolves to the one a click there follows, or null.
// Clicks on clips' own controls go to the clips, as before.

// What a clip does at `time` seconds of `duration`: null to carry on, else `{seek}` (back to its
// trim start, looping) or `{stop}`. Untrimmed clips are left to the media element and its own
// loop. A trimmed clip ends at `duration - trimEndMs`, and loops from `trimStartMs`: the element's
// own loop would replay the part trimmed off the start.
export function trimStep ({ trimStartMs = 0, trimEndMs = 0, loop = false }, time, duration) {
  if ((!trimStartMs && !trimEndMs) || !Number.isFinite(duration)) return null
  const start = trimStartMs / 1000
  const end = Math.max(start, duration - trimEndMs / 1000)
  if (time < end) return null
  return loop ? { seek: start } : { stop: true }
}

// A YouTube video's id, and its start and end in ms (0 when unset), from any form of YouTube link;
// null for anything else. PowerPoint saves an inserted online video as its embed URL.
export function youtubeVideo (link) {
  let u
  try { u = new URL(link) } catch { return null }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const host = u.hostname.replace(/^(www|m)\./, '')
  const [first, second] = u.pathname.split('/').filter(Boolean)
  let id = null
  if (host === 'youtu.be') id = first
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (['embed', 'shorts', 'live'].includes(first)) id = second
    else if (first === 'watch') id = u.searchParams.get('v')
  }
  if (!/^[A-Za-z0-9_-]{11}$/.test(id ?? '')) return null
  const ms = t => {
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(t ?? '')
    return m ? ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000 : 0
  }
  return { id, startMs: ms(u.searchParams.get('start') ?? u.searchParams.get('t')), endMs: ms(u.searchParams.get('end')) }
}

const youtubeApis = new WeakMap()

// Errors named as a media element's play() names them: NotAllowedError for blocked sound,
// NotSupportedError for a video that can't play.
const mediaError = (name, message) => Object.assign(new Error(message), { name })

// The YouTube IFrame API of `win`, loaded once, and only when a deck has a YouTube video.
export function loadYouTubeApi (win = globalThis, timeoutMs = 15000) {
  if (win.YT?.Player) return Promise.resolve(win.YT)
  if (youtubeApis.has(win)) return youtubeApis.get(win)
  const loading = new Promise((resolve, reject) => {
    const fail = () => {
      clearTimeout(timer)
      youtubeApis.delete(win)
      reject(new Error('youtube-unavailable'))
    }
    const timer = setTimeout(fail, timeoutMs)
    const earlier = win.onYouTubeIframeAPIReady
    win.onYouTubeIframeAPIReady = () => {
      earlier?.()
      clearTimeout(timer)
      resolve(win.YT)
    }
    const s = win.document.createElement('script')
    s.src = 'https://www.youtube.com/iframe_api'
    s.onerror = fail
    win.document.head.append(s)
  })
  youtubeApis.set(win, loading)
  return loading
}

// A YouTube video with the part of a media element's interface the player uses: play() and
// pause(), paused, currentTime, duration, volume, loop, and the play, pause, timeupdate, seeked and
// ended events (plus error). seeked is fired for a seek in YouTube's own controls only. Its player is made the first time it's shown (mount). `api` gives the
// YouTube IFrame API; `box` is the element it's drawn in.
export class YouTubeClip extends EventTarget {
  constructor ({ id, box, api, endMs = 0, now = () => performance.now() }) {
    super()
    this.id = id
    this.box = box
    this.style = box.style
    this.api = api
    this.src = `https://www.youtube-nocookie.com/embed/${id}`
    this.end = endMs / 1000
    this.controls = false
    this.loop = false
    this.player = null
    this.failed = false
    this.mounted = false
    this.destroyed = false
    this.paused_ = true
    this.volume_ = 1
    this.seek = null
    this.state = -1
    this.startAt = null
    this.waiting = []
    this.timer = null
    this.now = now
    this.last = null // {t, at}: the video's time, and when it was read
  }

  get paused () { return this.paused_ }

  get currentTime () { return this.player ? (this.startAt ?? this.player.getCurrentTime()) : (this.seek ?? 0) }

  // YouTube plays a video that hasn't started, or has ended, when asked to seek it, and drops a
  // play sent while a cue loads: a paused one keeps the time, and seeks there when it plays.
  set currentTime (t) {
    if (!this.player) {
      this.seek = t
    } else if (this.paused_ && [this.states.UNSTARTED, this.states.ENDED, this.states.CUED].includes(this.state)) {
      this.startAt = t
    } else {
      this.player.seekTo(t, true)
      this.last = null
    }
  }

  get duration () {
    const d = this.player?.getDuration() || 0
    if (!(d > 0)) return NaN
    return this.end > 0 ? Math.min(this.end, d) : d
  }

  get volume () { return this.volume_ }
  set volume (v) {
    this.volume_ = v
    this.player?.setVolume(Math.round(v * 100))
  }

  mount () {
    if (this.mounted) return
    this.mounted = true
    this.api().then(YT => this.create(YT), () => this.fail())
  }

  create (YT) {
    if (this.destroyed) return
    this.states = YT.PlayerState
    const target = this.box.appendChild(this.box.ownerDocument.createElement('div'))
    // eslint-disable-next-line no-new
    new YT.Player(target, {
      host: 'https://www.youtube-nocookie.com',
      videoId: this.id,
      width: '100%',
      height: '100%',
      playerVars: { controls: this.controls ? 1 : 0, disablekb: this.controls ? 0 : 1, playsinline: 1, rel: 0, iv_load_policy: 3 },
      events: {
        onReady: e => this.ready(e.target),
        onStateChange: e => this.changed(e.data),
        onAutoplayBlocked: () => this.stopped(mediaError('NotAllowedError', 'sound-blocked')),
        onError: () => this.fail()
      }
    })
  }

  ready (player) {
    if (this.destroyed) return player.destroy()
    this.player = player
    player.setVolume(Math.round(this.volume_ * 100))
    if (this.seek !== null) this.currentTime = this.seek
    this.seek = null
    if (!this.paused_) player.playVideo()
    this.timer = setInterval(() => this.tick(), 250)
    this.timer.unref?.()
  }

  play () {
    this.mount()
    if (this.failed) return Promise.reject(mediaError('NotSupportedError', 'video-unavailable'))
    if (this.paused_) {
      this.paused_ = false
      this.fire('play')
      if (this.player && this.startAt !== null) {
        this.player.seekTo(this.startAt, true)
        this.last = null
      }
      this.player?.playVideo()
    }
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }))
  }

  pause () {
    if (this.paused_) return
    this.paused_ = true
    this.player?.pauseVideo()
    this.fire('pause')
  }

  // YouTube's own state: a presenter can play and pause in YouTube's controls too.
  changed (state) {
    const S = this.states
    this.state = state
    if (state === S.PLAYING || state === S.PAUSED) this.startAt = null
    if (state === S.PLAYING) {
      for (const w of this.waiting.splice(0)) w.resolve()
      if (this.paused_) {
        this.paused_ = false
        this.fire('play')
      }
    } else if (state === S.PAUSED && !this.paused_) {
      this.paused_ = true
      this.fire('pause')
    } else if (state === S.ENDED) this.ended()
  }

  tick () {
    this.watchSeek()
    if (this.paused_) return
    this.fire('timeupdate')
    if (this.end > 0 && this.currentTime >= this.end) this.ended()
  }

  // YouTube reports no seeks: one in its controls is a jump further than playing could move it.
  watchSeek () {
    const S = this.states
    const t = this.player.getCurrentTime()
    const at = this.now()
    const last = this.last
    this.last = [S.PLAYING, S.PAUSED, S.BUFFERING].includes(this.state) ? { t, at } : null
    if (!last || !this.last) return
    const most = (at - last.at) / 1000 * (this.player.getPlaybackRate?.() || 1)
    if (t < last.t - 0.5 || t > last.t + most + 1) this.fire('seeked')
  }

  ended () {
    if (this.loop) {
      this.player.seekTo(0, true)
      this.last = null
      this.player.playVideo()
      return
    }
    if (!this.paused_) {
      this.paused_ = true
      this.player.pauseVideo()
      this.fire('pause')
    }
    this.fire('ended')
  }

  // A play that didn't happen: paused again, without a pause event (none was played).
  stopped (err) {
    this.paused_ = true
    for (const w of this.waiting.splice(0)) w.reject(err)
  }

  fail () {
    this.failed = true
    this.stopped(mediaError('NotSupportedError', 'video-unavailable'))
    this.fire('error')
  }

  fire (type) {
    queueMicrotask(() => this.dispatchEvent(new Event(type)))
  }

  stopTimer () {
    clearInterval(this.timer)
    this.timer = null
  }

  // A player that turns up after this is let go: see create and ready.
  destroy () {
    this.destroyed = true
    this.waiting = []
    this.stopTimer()
    this.player?.destroy()
  }
}

// The longest URL a link may have, as the worker's own limit.
export const MAX_URL_LENGTH = 2048

// `url` trimmed when a link may open it: http and https with a host, mailto and tel. null for
// anything else (javascript:, data:, file:, relative or malformed). The worker filters the same
// way; this is the page's own check before it opens anything.
export function safeLinkUrl (url) {
  if (typeof url !== 'string') return null
  const u = url.trim()
  if (!u || u.length > MAX_URL_LENGTH || /[\s\u0000-\u001f\u007f-\u009f]/.test(u)) return null
  let parsed
  try { parsed = new URL(u) } catch { return null }
  const rest = u.slice(u.indexOf(':') + 1)
  switch (parsed.protocol) {
    case 'http:':
    case 'https:': {
      // The host as written: the parser makes one up for 'https:///x'.
      const host = rest.startsWith('//') ? rest.slice(2).split(/[/?#]/)[0] : ''
      return host && !/^[@:]/.test(host) && parsed.hostname ? u : null
    }
    case 'mailto:': return rest ? u : null
    case 'tel:': return /^[A-Za-z0-9+\-.()*#;=,/%]+$/.test(rest) ? u : null
    default: return null
  }
}

// Is (x, y) inside the convex quadrilateral `quad` ([[x, y] × 4]), edges included?
export function insideQuad (quad, x, y) {
  if (!Array.isArray(quad) || quad.length !== 4) return false
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
  const area = cross(quad[0], quad[1], quad[2]) + cross(quad[0], quad[2], quad[3])
  if (!(Math.abs(area) > 1e-12)) return false
  const p = [x, y]
  return quad.every((a, i) => cross(a, quad[(i + 1) % 4], p) * Math.sign(area) >= -1e-12)
}

// Where a link's slide target goes in the show `slides` (info.slides) from `position`: a slide is
// entered as a click would enter it; Previous goes to the slide before, fully built. null for a
// target that isn't a slide, or a slide that isn't in the show.
export function linkDestination (target, slides, position) {
  const entry = s => [s.index, s.autoFirst ? 1 : 0]
  const k = slides.findIndex(s => s.index === position?.[0])
  switch (target?.type) {
    case 'slide': {
      const s = slides.find(x => x.index === target.index)
      return s ? entry(s) : null
    }
    case 'firstSlide': return slides.length ? entry(slides[0]) : null
    case 'lastSlide': return slides.length ? entry(slides[slides.length - 1]) : null
    case 'nextSlide': return k >= 0 && slides[k + 1] ? entry(slides[k + 1]) : null
    case 'previousSlide': return k > 0 ? [slides[k - 1].index, slides[k - 1].steps] : null
    default: return null
  }
}

// What a link's anchor is called: the linked text or the shape's alternative text, else its
// ScreenTip, else where it goes.
export function linkLabel (link, slides = []) {
  const t = link.target || {}
  const where = t.type === 'url'
    ? t.url.replace(/^(mailto|tel):/i, '')
    : t.type === 'slide'
      ? (() => {
          const k = slides.findIndex(s => s.index === t.index)
          const title = slides[k]?.title
          return k < 0 ? 'Slide' : title ? `Slide ${k + 1}: ${title}` : `Slide ${k + 1}`
        })()
      : { nextSlide: 'Next slide', previousSlide: 'Previous slide', firstSlide: 'First slide', lastSlide: 'Last slide', endShow: 'End show' }[t.type] || 'Link'
  const named = link.label || link.tooltip
  return named && named !== where ? `${named} (${where})` : where
}

// Hit tests sent to the worker, matched to their replies by id. Each resolves to a link or null;
// none is ever left waiting: a restart or too many at once resolve the oldest to null.
export class LinkRequests {
  constructor (max = 32) {
    this.nextId = 1
    this.max = max
    this.pending = new Map()
  }

  ask (worker, x, y) {
    const id = this.nextId++
    return new Promise(resolve => {
      this.pending.set(id, resolve)
      if (this.pending.size > this.max) this.settle({ id: this.pending.keys().next().value, link: null })
      worker.postMessage({ type: 'linkAt', id, x, y })
    })
  }

  // The worker's reply: {type: 'linkAt', id, link}.
  settle (m) {
    const resolve = this.pending.get(m.id)
    if (!resolve) return
    this.pending.delete(m.id)
    resolve(m.link ?? null)
  }

  cancel () {
    for (const resolve of this.pending.values()) resolve(null)
    this.pending.clear()
  }
}

// One speaker-notes request to the worker at a time: a newer request replaces a pending one. Each
// carries an id the worker echoes, so a late reply to a replaced request is dropped.
export class NotesRequest {
  constructor () {
    this.nextId = 1
    this.pending = null
  }

  ask (worker, url) {
    this.reject(new Error('replaced by a newer notes request'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject }
      worker.postMessage({ type: 'notes', url, id })
    })
  }

  // The worker's reply: {type: 'notes', id, notes: [{fileId, notes}]} or {type: 'notesError', id, message}.
  settle (m) {
    const p = this.pending
    if (!p || m.id !== p.id) return
    this.pending = null
    if (m.type === 'notes') p.resolve(new Map(m.notes.map(n => [n.fileId, n.notes])))
    else p.reject(new Error(m.message))
  }

  cancel () {
    this.reject(new Error('the player closed'))
  }

  reject (err) {
    const p = this.pending
    this.pending = null
    p?.reject(err)
  }
}

export class DeckcraftPlayer {
  constructor (container, { base = '', workerUrl, glueUrl, wasmUrl, fonts = [], fontsBase = null, mediaBase = null, mediaCredentials = null, controls = false, clock = () => Date.now(), linkHoverMs = 100 } = {}) {
    this.container = container
    this.base = base
    this.urls = { worker: workerUrl, glue: glueUrl, wasm: wasmUrl }
    this.fonts = fonts
    this.fontsBase = fontsBase
    this.mediaBase = mediaBase
    this.mediaCredentials = mediaCredentials
    this.controls = controls
    this.clock = clock
    this.handlers = {}
    this.notes = new NotesRequest()
    this.info = null
    this.media = []
    this.position = null
    this.restarts = 0
    this.source = null
    this.links = []
    this.linkRequests = new LinkRequests()
    this.linkHoverMs = linkHoverMs
    this.hover = { pointer: null, known: null, busy: false, again: false }
    // Anchors for the deck's links, under the clips: keyboards and screen readers use them, the
    // mouse goes through them to the canvas.
    this.linkLayer = document.createElement('div')
    this.linkLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none'
    this.layer = document.createElement('div')
    this.layer.style.cssText = 'position:absolute;inset:0;pointer-events:none'
    container.style.position = container.style.position || 'relative'
    this.syncTimer = setInterval(() => this.sync(), 1000)
    this.start()
  }

  on (name, fn) {
    (this.handlers[name] ||= []).push(fn)
    return this
  }

  emit (name, value) {
    for (const fn of this.handlers[name] || []) fn(value)
  }

  start () {
    this.canvas?.remove()
    this.canvas = document.createElement('canvas')
    this.canvas.style.cssText = 'display:block;width:100%;height:auto;background:#000'
    this.container.prepend(this.canvas)
    this.container.append(this.linkLayer, this.layer)
    this.canvas.addEventListener('pointermove', e => this.pointerMoved(e))
    this.canvas.addEventListener('pointerdown', e => this.pointerMoved(e, true))
    this.canvas.addEventListener('pointerleave', () => this.pointerLeft())
    this.canvas.addEventListener('click', e => this.clicked(e))
    const offscreen = this.canvas.transferControlToOffscreen()
    // Workers can't be created from another origin's script: start from a same-origin blob that
    // imports the real worker.
    const base = new URL(this.base, location.href).href
    const url = (given, name) => new URL(given || name, base).href
    const shim = new Blob([`importScripts(${JSON.stringify(url(this.urls.worker, 'worker.js'))})`], { type: 'text/javascript' })
    const shimUrl = URL.createObjectURL(shim)
    this.worker = new Worker(shimUrl)
    URL.revokeObjectURL(shimUrl)
    this.initialized = new Promise((resolve, reject) => {
      this.resolveInit = resolve
      this.rejectInit = reject
    })
    this.worker.onmessage = ({ data }) => this.receive(data)
    this.worker.onerror = e => this.crashed(e.message || 'the player stopped')
    this.worker.postMessage({
      type: 'init',
      glueUrl: url(this.urls.glue, 'deckcraft_player.js'),
      wasmUrl: url(this.urls.wasm, 'deckcraft_player_bg.wasm'),
      canvas: offscreen,
      fonts: this.fonts.map(f => url(f)),
      fontsBase: this.fontsBase && new URL(this.fontsBase, location.href).href,
      mediaBase: this.mediaBase && new URL(this.mediaBase, location.href).href,
      mediaCredentials: this.mediaCredentials,
    }, [offscreen])
    this.resizeObserver?.disconnect()
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(this.container)
  }

  async open (url) {
    this.source = url
    await this.initialized
    this.opened = new Promise((resolve, reject) => {
      this.resolveOpen = resolve
      this.rejectOpen = reject
    })
    this.worker.postMessage({ type: 'open', url: new URL(url, location.href).href })
    return this.opened
  }

  resize () {
    const width = Math.round(this.container.clientWidth * (window.devicePixelRatio || 1))
    if (width > 0) this.worker.postMessage({ type: 'resize', width })
  }

  jump (pos) {
    if (!pos) return
    this.position = pos
    this.stopMedia()
    this.worker.postMessage({ type: 'jump', slide: pos[0], step: pos[1] })
    this.showMedia()
  }

  advance (pos) {
    if (!pos) return
    const sameSlide = this.position && this.position[0] === pos[0]
    this.position = pos
    if (!sameSlide) this.stopMedia()
    this.worker.postMessage({ type: 'advance', slide: pos[0], step: pos[1] })
    this.showMedia()
  }

  // Where a click and Back go from `pos`, from the deck's step counts.
  nextOf ([slide, step]) {
    const slides = this.info?.slides || []
    const k = slides.findIndex(s => s.index === slide)
    if (k < 0) return null
    if (step < slides[k].steps) return [slide, step + 1]
    const n = slides[k + 1]
    return n ? [n.index, n.autoFirst ? 1 : 0] : null
  }

  prevOf ([slide, step]) {
    const slides = this.info?.slides || []
    const k = slides.findIndex(s => s.index === slide)
    if (k < 0) return null
    if (step > (slides[k].autoFirst ? 1 : 0)) return [slide, step - 1]
    const p = slides[k - 1]
    return p ? [p.index, p.steps] : null
  }

  receive (m) {
    switch (m.type) {
      case 'initialized': this.resolveInit(m); this.emit('metrics', { loadMs: m.loadMs }); break
      case 'ready':
        this.info = m.info
        this.buildMedia(m.media)
        this.position ||= [m.info.slides[0].index, m.info.slides[0].autoFirst ? 1 : 0]
        this.resize()
        this.jump(this.position)
        this.emit('metrics', { openMs: m.openMs })
        this.emit('ready', m.info)
        this.resolveOpen?.(m.info)
        break
      case 'state': this.emit('state', m); break
      case 'cues': for (const c of m.cues) this.cue(c.shape, c.action); break
      case 'metrics': this.emit('metrics', m); break
      case 'fonts': this.emit('fonts', { loaded: m.loaded, missing: m.missing }); break
      case 'images':
        this.emit('images', { loaded: m.loaded, failed: m.failed, bytes: m.bytes, ms: m.ms, slides: m.slides })
        this.emit('metrics', { imageMs: m.ms, imagesLoaded: m.loaded, imagesFailed: m.failed, imageBytes: m.bytes })
        break
      case 'notes':
      case 'notesError': this.notes.settle(m); break
      case 'links': this.showLinks(m.links); break
      case 'linkAt': this.linkRequests.settle(m); break
      // A picture that can't be fetched or drawn is reported and nothing more: it reaches the
      // page before `ready` (the first round runs before the first frame), and must not fail the
      // deck's open.
      case 'error':
        if (m.message === 'image-unavailable') {
          this.emit('error', m)
          break
        }
        if (!this.info) this.rejectInit(new Error(m.message))
        if (m.fatal) this.crashed(m.message)
        else {
          this.rejectOpen?.(new Error(m.message))
          this.emit('error', m)
        }
        break
    }
  }

  // Restart once, at the same position; a second crash is final.
  crashed (message) {
    this.emit('error', { message, fatal: this.restarts > 0 || !this.info })
    if (this.restarts > 0 || !this.info) return
    this.restarts += 1
    this.linkRequests.cancel()
    this.worker.terminate()
    this.start()
    this.open(this.source).catch(() => {})
  }

  buildMedia (clips) {
    this.releaseMedia()
    this.layer.replaceChildren()
    this.media = clips.map(clipData => {
      const yt = clipData.link ? youtubeVideo(clipData.link) : null
      // A link's start time is a trim start: cues play from it, and loops go back to it.
      const c = yt ? { ...clipData, trimStartMs: clipData.trimStartMs || yt.startMs } : clipData
      let el
      if (yt) {
        el = new YouTubeClip({ id: yt.id, endMs: yt.endMs, box: document.createElement('div'), api: () => loadYouTubeApi(window) })
        el.addEventListener('error', () => this.emit('error', { message: 'video-unavailable', fatal: false }))
      } else {
        el = document.createElement(c.video ? 'video' : 'audio')
        el.src = c.link || URL.createObjectURL(new Blob([c.data], { type: c.contentType }))
      }
      el.preload = 'auto'
      el.playsInline = true
      el.volume = Math.min(1, Math.max(0, c.volume ?? 1))
      el.loop = !!c.loop && !c.trimStartMs && !c.trimEndMs
      el.controls = this.controls
      const [x, y, w, h] = c.rect
      el.style.cssText = `position:absolute;left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%;object-fit:contain;display:none;pointer-events:${this.controls ? 'auto' : 'none'}`
      if (!c.video) el.style.height = 'auto'
      const clip = { ...c, el, data: undefined, quiet: 0 }
      const trim = () => {
        const step = trimStep(c, el.currentTime, el.duration)
        if (!step) return
        if (step.stop) return this.pause(clip)
        this.seek(clip, step.seek)
        if (el.paused) this.play(clip)
      }
      el.addEventListener('timeupdate', trim)
      el.addEventListener('ended', trim)
      if (this.controls) this.report(clip)
      this.layer.append(el.box ?? el)
      return clip
    })
  }

  // A presenter's own plays, pauses and seeks, for everyone else to follow: not the player's own. A
  // seek is sent as what the clip is doing (play or pause) at its new time.
  report (clip) {
    const { el, shape } = clip
    const send = action => {
      clip.anchor = { action, at: el.currentTime, time: this.clock() }
      this.emit('mediaAction', { shape, ...clip.anchor })
    }
    for (const action of ['play', 'pause']) {
      el.addEventListener(action, () => {
        if (clip.quiet > 0) clip.quiet -= 1
        else send(action)
      })
    }
    el.addEventListener('seeked', () => {
      const own = clip.ownSeek
      if (own && performance.now() < own.until && Math.abs(el.currentTime - own.t) < 0.25) return
      if (el.loop && el.currentTime < 0.25) return // a video starting over by itself
      send(el.paused ? 'pause' : 'play')
    })
  }

  // A seek the player makes itself. Its seeked event can come late, or never (a clip not loaded
  // yet), so it is recognised by its time for a few seconds rather than counted.
  seek (m, t) {
    m.ownSeek = { t, until: performance.now() + 3000 }
    m.jumped = this.clock()
    m.el.currentTime = t
    if ('playbackRate' in m.el) m.el.playbackRate = 1
  }

  // Clips being replaced or closed: their blob URLs, and their YouTube players and timers.
  releaseMedia () {
    for (const m of this.media) {
      if (m.el.src.startsWith('blob:')) URL.revokeObjectURL(m.el.src)
      m.el.destroy?.()
    }
    this.media = []
  }

  showMedia () {
    const slide = this.position?.[0]
    for (const m of this.media) {
      const shown = m.slide === slide && (m.video || this.controls)
      m.el.style.display = shown ? 'block' : 'none'
      if (shown) m.el.mount?.()
    }
  }

  stopMedia () {
    for (const m of this.media) {
      this.pause(m)
      this.seek(m, (m.trimStartMs || 0) / 1000)
      m.anchor = null
    }
  }

  // A media effect from the deck's timeline: Play starts over, Pause toggles, Stop rewinds.
  cue (shape, action) {
    const m = this.clip(shape)
    if (!m) return
    if (action === 'play') {
      this.seek(m, (m.trimStartMs || 0) / 1000)
      this.play(m)
    } else if (action === 'pause') {
      m.el.paused ? this.play(m) : this.pause(m)
    } else {
      this.pause(m)
      this.seek(m, (m.trimStartMs || 0) / 1000)
    }
    // Each client hears the cue at about the same moment, so its own clock anchors the clip.
    m.anchor = { action: m.el.paused ? 'pause' : 'play', at: m.el.currentTime, time: this.clock() }
  }

  // A clip played or paused by the presenter, `at` seconds in at `time`: every client does the
  // same, and a playing clip starts where it has got to since. Without a time (players before
  // 0.5.0), it starts at `at` and isn't kept in step.
  mediaAction ({ shape, action, at, time }) {
    const m = this.clip(shape)
    if (!m) return
    m.anchor = time == null ? null : { action, at, time }
    const t = m.anchor ? this.target(m) : at
    if (t == null) return this.pause(m)
    if (Math.abs(m.el.currentTime - t) > 0.5) this.seek(m, t)
    action === 'play' ? this.play(m) : this.pause(m)
  }

  // Where a clip should be now, by its anchor: null when it would have ended by now. A looping
  // clip goes round its trim range, or all of it.
  target (m) {
    const { action, at, time } = m.anchor
    if (action === 'pause') return at
    const t = at + Math.max(0, this.clock() - time) / 1000
    const { start, end } = this.span(m)
    if (!(end > start) || t < end) return t
    return m.loop ? start + (t - start) % (end - start) : null
  }

  span (m) {
    return { start: (m.trimStartMs || 0) / 1000, end: m.el.duration - (m.trimEndMs || 0) / 1000 }
  }

  // Every second, playing clips that have drifted from their anchor are brought back: a video a
  // little off plays 5% faster or slower, and one over a second off jumps. YouTube's speed can't
  // be nudged, so it only jumps. After a jump, a clip gets 3 s to load before it is checked again.
  sync () {
    const now = this.clock()
    for (const m of this.media) {
      if (m.anchor?.action !== 'play' || m.el.paused || m.slide !== this.position?.[0] || now - m.jumped < 3000) continue
      const t = this.target(m)
      if (t == null) continue
      let drift = m.el.currentTime - t
      const { start, end } = this.span(m)
      if (m.loop && end > start) {
        const s = end - start // just before the loop starts over is just behind, not far ahead
        drift = ((drift + s / 2) % s + s) % s - s / 2
      }
      if (Math.abs(drift) > 1) this.seek(m, t)
      else if ('playbackRate' in m.el) m.el.playbackRate = Math.abs(drift) < 0.1 ? 1 : drift > 0 ? 0.95 : 1.05
    }
  }

  clip (shape) {
    return this.media.find(x => x.shape === shape && x.slide === this.position?.[0])
  }

  // Plays and pauses made here aren't the presenter's own clicks: the event they fire is skipped
  // rather than reported back as a media action.
  play (m) {
    if (!m.el.paused) return
    m.quiet += 1
    m.el.play().catch(err => {
      m.quiet = Math.max(0, m.quiet - 1)
      // A clip that can't play at all isn't blocked sound: a YouTube video reports video-unavailable.
      if (err?.name !== 'NotSupportedError') this.emit('error', { message: 'sound-blocked', fatal: false })
    })
  }

  pause (m) {
    if (m.el.paused) return
    m.quiet += 1
    m.el.pause()
  }

  // The link a click at (x, y) follows, in fractions of the slide: resolves to one of `links`, or
  // null.
  linkAt (x, y) {
    return this.linkRequests.ask(this.worker, x, y)
  }

  // Does a link do anything for this viewer? A URL opens for everyone; slide targets move only a
  // viewer with controls.
  linkActs (link) {
    const t = link?.target
    return t?.type === 'url' ? !!safeLinkUrl(t.url) : !!t && this.controls
  }

  // The point under a pointer event, in fractions of the slide (the canvas is the slide).
  pointOf (e) {
    const r = this.canvas.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) return null
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]
  }

  // Is any link's box under (x, y)? Only then is the worker asked: a hit is always one of them.
  nearLink ([x, y]) {
    return this.links.some(l => insideQuad(l.quad, x, y))
  }

  // The pointer moved (or went down): over a link's box, ask the worker what is there, at most once
  // per linkHoverMs; elsewhere the cursor is the page's at once. A touch has no hover, so its
  // pointerdown asks straight away, for the click that follows.
  pointerMoved (e, now = false) {
    const p = this.pointOf(e)
    const h = this.hover
    h.pointer = p
    if (!p || !this.nearLink(p)) {
      h.again = false
      h.known = p && { at: p, link: null }
      this.showHover(null)
      return
    }
    if (h.busy && !now) {
      h.again = true
      return
    }
    this.hoverAt(p)
  }

  pointerLeft () {
    this.hover.pointer = null
    this.hover.again = false
    this.showHover(null)
  }

  hoverAt (p) {
    const h = this.hover
    h.busy = true
    h.again = false
    let replied = false
    let waited = false
    const done = () => {
      if (!replied || !waited) return
      h.busy = false
      if (h.again && h.pointer) this.hoverAt(h.pointer)
    }
    clearTimeout(h.timer)
    h.timer = setTimeout(() => {
      waited = true
      done()
    }, this.linkHoverMs)
    this.linkAt(p[0], p[1]).then(link => {
      replied = true
      h.known = { at: p, link }
      // The pointer may have moved on since: still over a link's box, the answer stands until the
      // next one comes.
      if (h.pointer && this.nearLink(h.pointer)) this.showHover(link)
      done()
    })
  }

  showHover (link) {
    if (!this.canvas) return
    this.canvas.style.cursor = this.linkActs(link) ? 'pointer' : ''
    this.canvas.title = link?.tooltip || ''
  }

  // A click on the slide. Off every link's box it is the page's. On one, it is the link's: the page
  // doesn't see it, and the link is followed once the worker says which it is (at once when the
  // hover already knows). A click on a box another shape covers does nothing.
  clicked (e) {
    const p = this.pointOf(e)
    if (!p) return
    const known = this.hover.known
    const same = known && Math.abs(known.at[0] - p[0]) < 1e-3 && Math.abs(known.at[1] - p[1]) < 1e-3
    if (same ? !known.link : !this.nearLink(p)) return
    e.preventDefault()
    e.stopImmediatePropagation()
    if (same) this.follow(known.link)
    else this.linkAt(p[0], p[1]).then(link => link && this.follow(link))
  }

  // Emit `link`, then, unless the page prevents it, open a URL or (with controls) go to a slide.
  follow (link) {
    const target = link.target || {}
    const url = target.type === 'url' ? safeLinkUrl(target.url) : null
    if (target.type === 'url' && !url) return
    const position = linkDestination(target, this.info?.slides || [], this.position)
    const e = {
      target: url ? { ...target, url } : target,
      position,
      moves: !!position && this.controls,
      shape: link.shape,
      text: !!link.text,
      label: link.label || '',
      tooltip: link.tooltip || '',
      defaultPrevented: false,
      preventDefault () { this.defaultPrevented = true },
    }
    this.emit('link', e)
    if (e.defaultPrevented) return
    if (url) this.openLink(url)
    else if (e.moves) this.advance(position)
  }

  openLink (url) {
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  // The worker's links for the position shown: kept for hit tests, and an anchor over each one
  // that does something here.
  showLinks (links) {
    this.links = Array.isArray(links) ? links : []
    this.hover.known = null
    const doc = this.linkLayer.ownerDocument
    const seen = new Set()
    const anchors = this.links.filter(l => this.linkActs(l)).map(link => {
      const a = doc.createElement('a')
      const url = link.target.type === 'url' ? safeLinkUrl(link.target.url) : null
      a.href = url || '#'
      if (url) {
        a.target = '_blank'
        a.rel = 'noopener noreferrer'
      }
      a.setAttribute('aria-label', linkLabel(link, this.info?.slides || []))
      // A run of text over several lines is one link: keyboards and screen readers get its first box.
      const key = JSON.stringify([link.shape, link.text, link.target, link.label])
      if (seen.has(key)) {
        a.tabIndex = -1
        a.setAttribute('aria-hidden', 'true')
      }
      seen.add(key)
      const [x, y, w, h] = link.rect
      a.style.cssText = `position:absolute;left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%;pointer-events:none;background:transparent`
      a.addEventListener('click', e => {
        e.preventDefault()
        e.stopPropagation()
        this.follow(link)
      })
      return a
    })
    this.linkLayer.replaceChildren(...anchors)
  }

  // The speaker notes of another deck (the original of the attendee copy on screen), by file
  // slide id. Notes stay here: never send them on to other people.
  notesOf (url) {
    return this.notes.ask(this.worker, new URL(url, location.href).href)
  }

  destroy () {
    this.notes.cancel()
    this.linkRequests.cancel()
    clearTimeout(this.hover.timer)
    clearInterval(this.syncTimer)
    this.resizeObserver?.disconnect()
    this.worker?.terminate()
    this.releaseMedia()
    this.container.replaceChildren()
  }
}
