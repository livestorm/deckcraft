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
//
// Events (p.on(name, fn)): ready(info), state({slide, step, animating}), metrics(m), error(err),
// fonts({loaded: [{family, from}], missing: [family]}) with fontsBase,
// mediaAction({shape, action, at}) when someone with controls plays or pauses a clip themselves.

export class DeckcraftPlayer {
  constructor (container, { base = '', workerUrl, glueUrl, wasmUrl, fonts = [], fontsBase = null, controls = false } = {}) {
    this.container = container
    this.base = base
    this.urls = { worker: workerUrl, glue: glueUrl, wasm: wasmUrl }
    this.fonts = fonts
    this.fontsBase = fontsBase
    this.controls = controls
    this.handlers = {}
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
    this.media = clips.map(c => {
      const el = document.createElement(c.video ? 'video' : 'audio')
      el.src = c.link || URL.createObjectURL(new Blob([c.data], { type: c.contentType }))
      el.preload = 'auto'
      el.playsInline = true
      el.volume = Math.min(1, Math.max(0, c.volume ?? 1))
      el.controls = this.controls
      const [x, y, w, h] = c.rect
      el.style.cssText = `position:absolute;left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%;object-fit:contain;display:none;pointer-events:${this.controls ? 'auto' : 'none'}`
      if (!c.video) el.style.height = 'auto'
      const clip = { ...c, el, data: undefined, quiet: 0 }
      if (this.controls) {
        const report = action => () => {
          if (clip.quiet > 0) clip.quiet -= 1
          else this.emit('mediaAction', { shape: c.shape, action, at: el.currentTime })
        }
        el.addEventListener('play', report('play'))
        el.addEventListener('pause', report('pause'))
      }
      this.layer.append(el)
      return clip
    })
  }

  showMedia () {
    const slide = this.position?.[0]
    for (const m of this.media) m.el.style.display = m.slide === slide && (m.video || this.controls) ? 'block' : 'none'
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

  destroy () {
    this.resizeObserver?.disconnect()
    this.worker?.terminate()
    for (const m of this.media) if (m.el.src.startsWith('blob:')) URL.revokeObjectURL(m.el.src)
    this.container.replaceChildren()
  }
}
