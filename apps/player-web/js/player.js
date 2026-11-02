// Page side of the DeckCraft player: a canvas drawn by the worker, plus the deck's audio and video
// played in the browser's own elements over it, so they have sound.
//
//   const p = new DeckcraftPlayer(container, { base: '/deckcraft/0.1.0/', fonts: [...] })
// `base` holds worker.js, deckcraft_player.js and deckcraft_player_bg.wasm. When a bundler gives
// them their own (hashed) URLs, pass those instead: { workerUrl, glueUrl, wasmUrl, fonts }.
// `fontsBase` is a font server (a Google Fonts mirror): each deck then downloads just the
// fonts it uses, before its first slide is drawn. `fonts` are added up front either way.
//   await p.open(url)
//   p.advance(p.nextOf(p.position)) // a click
//   p.jump(pos)                     // a jump, at rest
//   await p.notesOf(originalUrl)    // presenters: Map of file slide id → notes of another deck;
//                                   // the current slide's is info.slides[k].fileId
//
// Events (p.on(name, fn)): ready(info), state({slide, step, animating}), metrics(m), error(err),
// fonts({loaded: [{family, from}], missing: [family]}) with fontsBase,
// mediaAction({shape, action, at}) when someone with controls plays or pauses a clip themselves.
// A YouTube video (PowerPoint's online video) plays in YouTube's player, in privacy-enhanced mode;
// one that can't play gives error({message: 'video-unavailable', fatal: false}).

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
// pause(), paused, currentTime, duration, volume, loop, and the play, pause, timeupdate and ended
// events (plus error). Its player is made the first time it's shown (mount). `api` gives the
// YouTube IFrame API; `box` is the element it's drawn in.
export class YouTubeClip extends EventTarget {
  constructor ({ id, box, api, endMs = 0 }) {
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
    this.paused_ = true
    this.volume_ = 1
    this.seek = null
    this.state = -1
    this.startAt = null
    this.waiting = []
    this.timer = null
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
        onAutoplayBlocked: () => this.stopped(new Error('sound-blocked')),
        onError: () => this.fail()
      }
    })
  }

  ready (player) {
    this.player = player
    player.setVolume(Math.round(this.volume_ * 100))
    if (this.seek !== null) this.currentTime = this.seek
    this.seek = null
    if (!this.paused_) player.playVideo()
  }

  play () {
    this.mount()
    if (this.failed) return Promise.reject(new Error('video-unavailable'))
    if (this.paused_) {
      this.paused_ = false
      this.fire('play')
      if (this.player && this.startAt !== null) this.player.seekTo(this.startAt, true)
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
      if (!this.timer) {
        this.timer = setInterval(() => this.tick(), 250)
        this.timer.unref?.()
      }
      return
    }
    this.stopTimer()
    if (state === S.PAUSED && !this.paused_) {
      this.paused_ = true
      this.fire('pause')
    } else if (state === S.ENDED) this.ended()
  }

  tick () {
    this.fire('timeupdate')
    if (this.end > 0 && !this.paused_ && this.currentTime >= this.end) this.ended()
  }

  ended () {
    if (this.loop) {
      this.player.seekTo(0, true)
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
    this.stopped(new Error('video-unavailable'))
    this.fire('error')
  }

  fire (type) {
    queueMicrotask(() => this.dispatchEvent(new Event(type)))
  }

  stopTimer () {
    clearInterval(this.timer)
    this.timer = null
  }

  destroy () {
    this.stopTimer()
    this.player?.destroy()
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
  constructor (container, { base = '', workerUrl, glueUrl, wasmUrl, fonts = [], fontsBase = null, controls = false } = {}) {
    this.container = container
    this.base = base
    this.urls = { worker: workerUrl, glue: glueUrl, wasm: wasmUrl }
    this.fonts = fonts
    this.fontsBase = fontsBase
    this.controls = controls
    this.handlers = {}
    this.notes = new NotesRequest()
    this.info = null
    this.media = []
    this.position = null
    this.restarts = 0
    this.source = null
    this.layer = document.createElement('div')
    this.layer.style.cssText = 'position:absolute;inset:0;pointer-events:none'
    container.style.position = container.style.position || 'relative'
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
    this.container.append(this.layer)
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
      case 'notes':
      case 'notesError': this.notes.settle(m); break
      case 'error':
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
    this.worker.terminate()
    this.start()
    this.open(this.source).catch(() => {})
  }

  buildMedia (clips) {
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
        el.currentTime = step.seek
        if (el.paused) this.play(clip)
      }
      el.addEventListener('timeupdate', trim)
      el.addEventListener('ended', trim)
      if (this.controls) {
        const report = action => () => {
          if (clip.quiet > 0) clip.quiet -= 1
          else this.emit('mediaAction', { shape: c.shape, action, at: el.currentTime })
        }
        el.addEventListener('play', report('play'))
        el.addEventListener('pause', report('pause'))
      }
      this.layer.append(el.box ?? el)
      return clip
    })
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
      m.el.currentTime = (m.trimStartMs || 0) / 1000
    }
  }

  // A media effect from the deck's timeline: Play starts over, Pause toggles, Stop rewinds.
  cue (shape, action) {
    const m = this.clip(shape)
    if (!m) return
    if (action === 'play') {
      m.el.currentTime = (m.trimStartMs || 0) / 1000
      this.play(m)
    } else if (action === 'pause') {
      m.el.paused ? this.play(m) : this.pause(m)
    } else {
      this.pause(m)
      m.el.currentTime = (m.trimStartMs || 0) / 1000
    }
  }

  // A clip played or paused by the presenter, `at` seconds in: every client does the same.
  mediaAction ({ shape, action, at }) {
    const m = this.clip(shape)
    if (!m) return
    if (Math.abs(m.el.currentTime - at) > 0.5) m.el.currentTime = at
    action === 'play' ? this.play(m) : this.pause(m)
  }

  clip (shape) {
    return this.media.find(x => x.shape === shape && x.slide === this.position?.[0])
  }

  // Plays and pauses made here aren't the presenter's own clicks: the event they fire is skipped
  // rather than reported back as a media action.
  play (m) {
    if (!m.el.paused) return
    m.quiet += 1
    m.el.play().catch(() => {
      m.quiet = Math.max(0, m.quiet - 1)
      this.emit('error', { message: 'sound-blocked', fatal: false })
    })
  }

  pause (m) {
    if (m.el.paused) return
    m.quiet += 1
    m.el.pause()
  }

  // The speaker notes of another deck (the original of the attendee copy on screen), by file
  // slide id. Notes stay here: never send them on to other people.
  notesOf (url) {
    return this.notes.ask(this.worker, new URL(url, location.href).href)
  }

  destroy () {
    this.notes.cancel()
    this.resizeObserver?.disconnect()
    this.worker?.terminate()
    for (const m of this.media) {
      if (m.el.src.startsWith('blob:')) URL.revokeObjectURL(m.el.src)
      m.el.destroy?.()
    }
    this.container.replaceChildren()
  }
}
