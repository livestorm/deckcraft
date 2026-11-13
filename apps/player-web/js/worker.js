// DeckCraft player worker: owns the deck and the canvas; the page sends positions and gets
// pictures drawn, media clips and media cues back.
//
// In:  {type: 'init', glueUrl, wasmUrl, canvas: OffscreenCanvas, fonts: [url], fontsBase,
//        mediaBase, mediaCredentials}
//      {type: 'open', url} | {type: 'open', bytes: ArrayBuffer}
//      {type: 'resize', width}
//      {type: 'jump', slide, step} | {type: 'advance', slide, step}
//      {type: 'notes', url, id} | {type: 'notes', bytes, id}: another deck's speaker notes. The
//        download runs alongside everything else; only reading the deck joins the queue
//      {type: 'linkAt', id, x, y}: the link a click at (x, y) follows, in fractions of the slide's
//        width and height. Answered at once, outside the queue
// Out: {type: 'initialized', loadMs}
//      {type: 'fonts', loaded: [{family, from}], missing: [family]} when fontsBase is set
//      {type: 'ready', info, media, openMs}
//      {type: 'images', loaded, failed, bytes, ms, slides: [index]}: one round of the deck's linked
//        pictures (pictures whose bytes live outside it) fetched, with mediaBase set. The first
//        round is the starting slide's, sent before 'ready' (even when it had none). After that
//        only the window of the slide on screen is fetched (IMAGE_WINDOW: that slide, the next
//        two and the previous one, in show order), once after 'ready' and again on every move
//        that brings pictures not yet fetched or tried; each such round sends its own message when
//        its fetches end, so a deck sends several and the counts add up. A picture is fetched at
//        most once, a failed one included. `slides` are the slides whose pictures arrived in that
//        round
//      {type: 'state', slide, step, animating}
//      {type: 'cues', cues: [{shape, action}]}
//      {type: 'metrics', frameMs, width, height}
//      {type: 'notes', id, notes: [{fileId, notes}]} | {type: 'notesError', id, message}
//      {type: 'links', slide, step, links: [link]}: the links a viewer can click, back to front,
//        sent after 'ready' and whenever the position changes
//      {type: 'linkAt', id, link: link | null}: the reply to a linkAt, by its id
//        link: {target, shape, text, rect: [x, y, w, h], quad: [[x, y] × 4], tooltip, label}, in
//        fractions of the slide; target: {type: 'url', url} (http, https, mailto or tel),
//        {type: 'slide', index, fileId}, or {type: 'nextSlide' | 'previousSlide' | 'firstSlide' |
//        'lastSlide' | 'endShow'}
//      {type: 'error', message, fatal}: fatal only for a trap in the module or a failed init;
//        a linked picture that can't be fetched or drawn is {message: 'image-unavailable', url,
//        slide, reason, fatal: false} and leaves the deck playing

/* global wasm_bindgen */ // declared by deckcraft_player.js, imported below

let player = null
let canvas = null
let fontsBase = null
let mediaBase = null
let mediaCredentials = null
let ctx = null // 2D fallback when WebGL2 isn't available
let gl = null
let scheduled = false
let lastState = ''
let lastLinks = ''
let ready = false // the deck on screen has its fonts: its links are where they are drawn
let pictures = null // the deck on screen's linked-picture windows: pictures(slide) (openImages)

// WebGL2: every picture is a texture drawn as triangles; transitions are the layers' meshes over
// the slides' textures, so a frame costs a few dozen vertices instead of a CPU composite.
const gpu = {
  program: null,
  buffer: null,
  index: null,
  textures: [],
  slide: null,

  init (c) {
    gl = c.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false })
    if (!gl) return false
    const shader = (type, src) => {
      const sh = gl.createShader(type)
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh))
      return sh
    }
    const p = gl.createProgram()
    gl.attachShader(p, shader(gl.VERTEX_SHADER, `#version 300 es
      in vec2 pos; in vec2 uv; in float a;
      out vec2 vUv; out float vA;
      void main () { vUv = uv; vA = a; gl_Position = vec4(pos.x * 2.0 - 1.0, 1.0 - pos.y * 2.0, 0.0, 1.0); }`))
    gl.attachShader(p, shader(gl.FRAGMENT_SHADER, `#version 300 es
      precision mediump float;
      in vec2 vUv; in float vA;
      uniform sampler2D tex; uniform bool solid; uniform vec3 color;
      out vec4 outColor;
      void main () { vec4 c = solid ? vec4(color, 1.0) : texture(tex, vUv); outColor = vec4(c.rgb, c.a * vA); }`))
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p))
    this.program = p
    this.buffer = gl.createBuffer()
    this.index = gl.createBuffer()
    gl.useProgram(p)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.index)
    const attr = (name, size, offset) => {
      const loc = gl.getAttribLocation(p, name)
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 20, offset)
    }
    attr('pos', 2, 0)
    attr('uv', 2, 8)
    attr('a', 1, 16)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    return true
  },

  upload (tex, pic) {
    tex ||= gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, pic.width, pic.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(pic.rgba.buffer, pic.rgba.byteOffset, pic.rgba.byteLength))
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return tex
  },

  size (w, h) {
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    gl.viewport(0, 0, w, h)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
  },

  layer (texture, color, vertices, indices) {
    gl.uniform1i(gl.getUniformLocation(this.program, 'solid'), texture ? 0 : 1)
    gl.uniform3fv(gl.getUniformLocation(this.program, 'color'), color)
    if (texture) gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STREAM_DRAW)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STREAM_DRAW)
    gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_INT, 0)
  },

  picture (f) {
    this.slide = this.upload(this.slide, f)
    this.size(f.width, f.height)
    this.layer(this.slide, [0, 0, 0], new Float32Array([0, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1, 1, 0, 1, 0, 1, 1]), new Uint32Array([0, 1, 2, 0, 2, 3]))
  },

  transition (f, tr) {
    if (tr.textures) this.textures = tr.textures.map((pic, i) => (pic ? this.upload(this.textures[i], pic) : null))
    this.size(f.width, f.height)
    for (const l of tr.layers) {
      const tex = l.texture === null ? null : this.textures[l.texture]
      if (l.texture !== null && !tex) continue
      this.layer(tex, l.color, l.vertices, l.indices)
    }
  },
}

// Fonts on demand: with `fontsBase`, a deck's fonts come from a font server laid out as
// <fontsBase>families/<key>/family.json plus the faces it lists (see the npm README).
// A family's folder: its name lowercased, spaces as hyphens, as one URL segment. The name comes
// from the deck, so it is encoded: '../x' or '?' can't point a fetch outside the font folders.
// '' for a name that is only dots or space, which is never fetched.
const familyKey = name => {
  const key = name.trim().toLowerCase().replace(/\s+/g, '-')
  return /^\.*$/.test(key) ? '' : encodeURIComponent(key)
}

// At most this many font fetches at once, however many fonts a deck asks for.
const MAX_FETCHES = 6

// The face nearest `weight` in the asked style (the heavier on a tie), else in the other style.
function pickFace (faces, weight, italic) {
  const nearest = list => list.reduce((best, f) => {
    if (!best) return f
    const d = Math.abs(f.weight - weight) - Math.abs(best.weight - weight)
    return d < 0 || (d === 0 && f.weight > best.weight) ? f : best
  }, null)
  return nearest(faces.filter(f => f.italic === italic)) || nearest(faces)
}

// For each request ({family, weight, italic, candidates} from WebPlayer.fontRequests), the
// first candidate the server has: [{family, from, bytes}]. A family's family.json and each file
// are fetched once; a miss or a failure moves on to the next candidate.
async function loadFonts (requests, base, fetchFn = fetch) {
  const root = base.endsWith('/') ? base : `${base}/`
  const cache = new Map()
  const once = (key, load) => {
    if (!cache.has(key)) cache.set(key, load().catch(() => null))
    return cache.get(key)
  }
  let running = 0
  const waiting = []
  const get = async (url, read) => {
    if (running >= MAX_FETCHES) await new Promise(resolve => waiting.push(resolve))
    running++
    try {
      const r = await fetchFn(url)
      if (!r.ok) throw new Error(`${url}: ${r.status}`)
      return await read(r)
    } finally {
      running--
      waiting.shift()?.()
    }
  }
  const url = (name, file) => `${root}families/${familyKey(name)}/${file}`
  const one = async req => {
    for (const name of req.candidates.filter(familyKey)) {
      const family = await once(url(name, 'family.json'), () => get(url(name, 'family.json'), r => r.json()))
      const face = family && pickFace(family.faces || [], req.weight, req.italic)
      const buf = face && await once(url(name, face.file), () => get(url(name, encodeURIComponent(face.file)), r => r.arrayBuffer()))
      if (buf) return { family: req.family, from: family.family, bytes: new Uint8Array(buf) }
    }
    return null
  }
  return (await Promise.all(requests.map(one))).filter(Boolean)
}

// Linked pictures: a deck can name pictures whose bytes live outside it (PowerPoint's Link to
// File, or a media service that takes large pictures out of the copy viewers download). The module
// lists only those under `mediaBase`, normalised; without `mediaBase` nothing is ever fetched.
//
// At most this many picture fetches at once, and this long for one of them.
const MAX_IMAGE_FETCHES = 4
const IMAGE_TIMEOUT_MS = 20000
// Longest URL fetched for a picture.
const MAX_MEDIA_URL = 2048
// Most bytes read for one picture, and for all of one deck's: the player's own limits
// (MAX_LINKED_IMAGE_BYTES, MAX_LINKED_TOTAL_BYTES), applied while downloading so an oversized
// response is dropped before it is held in memory.
const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const MAX_DECK_IMAGE_BYTES = 256 * 1024 * 1024

// A response's body as bytes, read as it arrives and abandoned once it passes `max` bytes or the
// deck's remaining `budget` ({left}), whichever is smaller. The budget is spent as bytes arrive.
async function readCapped (r, max, budget) {
  const limit = () => Math.min(max, budget.left)
  const declared = Number(r.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > limit()) throw new Error(declared > max ? 'too-large' : 'deck-budget')
  const tooBig = n => new Error(n > max ? 'too-large' : 'deck-budget')
  if (!r.body?.getReader) {
    const buf = new Uint8Array(await r.arrayBuffer())
    if (buf.byteLength > limit()) throw tooBig(buf.byteLength)
    budget.left -= buf.byteLength
    return buf
  }
  const reader = r.body.getReader()
  const chunks = []
  let n = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      n += value.byteLength
      if (n > limit()) throw tooBig(n)
      chunks.push(value)
    }
  } catch (err) {
    reader.cancel().catch(() => {})
    throw err
  }
  budget.left -= n
  const out = new Uint8Array(n)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

// `url` as it may be fetched for a deck: an https URL under `base`, the host's media prefix. The
// player applies this rule too (deckcraft_player::media_url) and lists only what passes it; it is
// applied again here, as link URLs are, so nothing reaches `fetch` that the page didn't allow.
// Rejected: any other scheme (`file:` above all, which PowerPoint's Link to File writes), another
// origin, credentials in the URL, dot segments encoded or not, backslashes, spaces.
function mediaUrl (url, base) {
  const clean = s => typeof s === 'string' && s.length <= MAX_MEDIA_URL && /^[\x21-\x7e]*$/.test(s) && !s.includes('\\')
  if (!clean(url) || !clean(base)) return null
  let prefix, target
  try {
    prefix = new URL(base)
    target = new URL(url)
  } catch { return null }
  if (prefix.protocol !== 'https:' || prefix.search || prefix.hash || prefix.username || prefix.password) return null
  if (target.protocol !== 'https:' || target.username || target.password) return null
  if (target.origin !== prefix.origin) return null
  const dir = prefix.pathname.endsWith('/') ? prefix.pathname : `${prefix.pathname}/`
  // `new URL` already resolves `..`; compare the resolved path, and refuse encoded separators.
  if (!target.pathname.startsWith(dir) || target.pathname === dir) return null
  if (/%2e|%2f|%5c/i.test(target.pathname)) return null
  return `${target.origin}${target.pathname}${target.search}`
}

// Fetch one linked picture `img` ({media, url, slides}) and hand its bytes to `setImage(media,
// bytes)`, abandoned after `timeoutMs`. Never throws: a failed fetch, or bytes the player refuses,
// goes to `failed` and resolves to null; otherwise resolves to the number of bytes.
async function fetchImage (img, { fetchFn = fetch, setImage, failed = () => {}, credentials = null, timeoutMs = IMAGE_TIMEOUT_MS, maxBytes = MAX_IMAGE_BYTES, budget = { left: MAX_DECK_IMAGE_BYTES } } = {}) {
  const stop = new AbortController()
  const timer = setTimeout(() => stop.abort(), timeoutMs)
  try {
    // A redirect is never followed: it could leave the media prefix that `mediaUrl` checked, and
    // with credentials take them to another origin. A media server serves pictures in place.
    const r = await fetchFn(img.url, { signal: stop.signal, redirect: 'error', ...(credentials ? { credentials } : {}) })
    if (!r.ok) throw new Error(`status ${r.status}`)
    const buf = await readCapped(r, maxBytes, budget)
    setImage(img.media, buf)
    return buf.byteLength
  } catch (err) {
    const reason = stop.signal.aborted ? 'timeout' : String(err && err.message ? err.message : err)
    failed({ url: img.url, slide: img.slides?.[0] ?? null, reason })
    return null
  } finally {
    clearTimeout(timer)
  }
}

// The pictures a viewer is about to see are fetched, not the whole deck's: those of the slide on
// screen, the `ahead` slides after it and the `behind` slides before it, in the show's order
// (hidden slides and slides outside a custom show or range are not in it).
const IMAGE_WINDOW = { ahead: 2, behind: 1 }

// The slides of `slide`'s window, most urgent first: the slide itself, the ones after it, then the
// ones before it. `order` is the show's slide indexes in show order; a slide not in it (a hidden
// slide jumped to) is a window of its own.
function windowSlides (order, slide, { ahead, behind } = IMAGE_WINDOW) {
  const k = order.indexOf(slide)
  if (k < 0) return [slide]
  const out = order.slice(k, k + 1 + Math.max(0, ahead))
  for (let i = 1; i <= behind && k - i >= 0; i++) out.push(order[k - i])
  return out
}

const now = () => performance.now() / 1000
const post = (msg, transfer) => self.postMessage(msg, transfer || [])

// A trap in the WebAssembly module (a Rust panic) leaves it unusable: the page restarts the worker.
const fail = (err, fatal) => post({ type: 'error', message: String(err && err.message ? err.message : err), fatal: !!fatal })

const schedule = () => {
  if (scheduled || !player) return
  scheduled = true
  const next = self.requestAnimationFrame ? self.requestAnimationFrame.bind(self) : cb => setTimeout(cb, 16)
  next(tick)
}

function tick () {
  scheduled = false
  if (!player) return
  let f
  const t0 = performance.now()
  try {
    f = player.frame(now())
  } catch (err) {
    player = null
    fail(err, true)
    return
  }
  if (f.rgba || f.transition) {
    if (gl && f.transition) gpu.transition(f, f.transition)
    else if (gl) gpu.picture(f)
    else {
      if (canvas.width !== f.width || canvas.height !== f.height) {
        canvas.width = f.width
        canvas.height = f.height
      }
      ctx.putImageData(new ImageData(f.rgba, f.width, f.height), 0, 0)
    }
    post({ type: 'metrics', frameMs: performance.now() - t0, width: f.width, height: f.height, gpu: !!gl })
  }
  if (f.cues.length) post({ type: 'cues', cues: f.cues })
  const [slide, step] = player.position()
  const state = `${slide}/${step}/${f.animating}`
  if (state !== lastState) {
    lastState = state
    post({ type: 'state', slide, step, animating: f.animating })
  }
  if (ready && `${slide}/${step}` !== lastLinks) {
    lastLinks = `${slide}/${step}`
    try {
      post({ type: 'links', slide, step, links: player.links() })
    } catch (err) {
      player = null
      fail(err, true)
      return
    }
  }
  if (f.animating) schedule()
}

// The reply to a linkAt: the link under (x, y), or null when there is none, the deck isn't ready
// or the point isn't one. Always answered, so the page never waits; a trap in the module goes to
// `failed` as well.
function answerLinkAt ({ id, x, y }, { linkAt, post, failed = () => {} }) {
  let link = null
  if (Number.isFinite(x) && Number.isFinite(y)) {
    try {
      link = linkAt(x, y) ?? null
    } catch (err) {
      failed(err)
    }
  }
  post({ type: 'linkAt', id, link })
}

async function init ({ glueUrl, wasmUrl, canvas: c, fonts, fontsBase: fb, mediaBase: mb, mediaCredentials: mc }) {
  const t0 = performance.now()
  fontsBase = fb || null
  mediaBase = mb || null
  mediaCredentials = mc || null
  self.importScripts(glueUrl)
  await wasm_bindgen({ module_or_path: wasmUrl })
  const files = await Promise.all((fonts || []).map(url => fetch(url).then(r => (r.ok ? r.arrayBuffer() : null)).catch(() => null)))
  for (const buf of files) if (buf) wasm_bindgen.WebPlayer.addFont(new Uint8Array(buf))
  canvas = c
  if (!gpu.init(canvas)) ctx = canvas.getContext('2d')
  post({ type: 'initialized', loadMs: performance.now() - t0 })
}

async function open ({ url, bytes, download }) {
  const t0 = performance.now()
  const buf = bytes || await (download || fetch(url)).then(r => {
    if (!r.ok) throw new Error(`could not download the presentation (${r.status})`)
    return r.arrayBuffer()
  })
  player = new wasm_bindgen.WebPlayer(new Uint8Array(buf))
  pictures = null
  ready = false
  if (fontsBase) {
    // Before the first frame, so text never switches font in front of the audience.
    const requests = player.fontRequests()
    const loaded = await loadFonts(requests, fontsBase)
    for (const f of loaded) {
      if (f.family) wasm_bindgen.WebPlayer.addFontAs(f.bytes, f.family)
      else wasm_bindgen.WebPlayer.addFont(f.bytes)
    }
    const missing = requests.filter(r => r.family && !loaded.some(f => f.family === r.family)).map(r => r.family)
    post({ type: 'fonts', loaded: loaded.map(f => ({ family: f.family || null, from: f.from })), missing: [...new Set(missing)] })
  }
  player.setGpuTransitions(!!gl)
  const info = player.info()
  // Linked pictures, before the first frame for the slide it starts on, so the audience never sees
  // it without them; then its window's, and every move's after that (`showImages`). The slide on
  // screen is drawn again when one of its pictures arrives.
  const deck = player
  const show = mediaBase ? await openImages({ deck, base: mediaBase, credentials: mediaCredentials, post, current: () => player, schedule, order: info.slides.map(s => s.index) }) : null
  if (player !== deck) return
  pictures = show
  const media = player.media()
  post({ type: 'ready', info, media, openMs: performance.now() - t0 }, media.map(m => m.data.buffer))
  lastState = ''
  lastLinks = ''
  ready = true
  schedule()
  showImages()
}

// Fetch the window of the slide now on screen. The downloads run outside the queue, so jumps and
// resizes keep their turn; a window that has nothing new to fetch does nothing.
function showImages () {
  if (!pictures || !player) return
  pictures(player.position()[0]).catch(err => fail(err))
}

// Fetch the deck's linked pictures by window. The starting slide's are fetched before this
// resolves (before the first frame); the returned function `show(slide)` then fetches the window of
// the slide on screen (`windowSlides`), and is called again whenever the position moves.
//
// - A picture is fetched at most once per deck: after it loaded, and after it failed (no retry).
// - At most `limit` fetches run at once, from one queue for the deck. A move puts the new window's
//   pictures at the front, the slide on screen's first, and drops the old window's that haven't
//   started (a later window may still ask for them); fetches already running finish.
// - Each round (the first, then each window that has something to fetch) reports one `images`
//   message once its fetches have all ended, with the pictures it started. One budget of
//   MAX_DECK_IMAGE_BYTES holds for all of them.
//
// Nothing here is fatal: a deck whose pictures can't be fetched still plays. `deck` is the player
// these pictures belong to; `current()` gives the worker's player, so once another `open` (or a
// crash) replaced it, nothing more starts, bytes still arriving are dropped instead of reaching the
// deck now on screen, and nothing more is reported for it. `order` is the show's slide indexes in
// show order (`info().slides[].index`).
async function openImages ({ deck, base, credentials, post, current, schedule, order = [], window = IMAGE_WINDOW, fetchFn = fetch, timeoutMs = IMAGE_TIMEOUT_MS, limit = MAX_IMAGE_FETCHES }) {
  const all = deck.linkedImages(base).filter(m => mediaUrl(m.url, base))
  const live = () => current() === deck
  const opts = {
    fetchFn,
    timeoutMs,
    setImage: (media, buf) => {
      if (!live()) return
      try {
        if (deck.setLinkedImage(media, buf)) schedule()
      } catch (err) {
        throw new Error(String(err && err.message ? err.message : err))
      }
    },
    failed: f => {
      if (live()) post({ type: 'error', message: 'image-unavailable', url: f.url, slide: f.slide, reason: f.reason, fatal: false })
    },
    credentials,
    // One budget for every round of the deck.
    budget: { left: MAX_DECK_IMAGE_BYTES },
  }
  const started = new Set() // media ids fetched or being fetched: never fetched again
  let queue = [] // [{img, round}] waiting for a slot, most urgent first
  let running = 0

  const newRound = always => {
    const round = { always, t0: performance.now(), waiting: new Set(), started: 0, loaded: 0, failed: 0, bytes: 0, slides: new Set(), ended: false }
    round.done = new Promise(resolve => { round.resolve = resolve })
    return round
  }
  // A round ends once nothing it claimed is queued or running; it reports if it fetched anything.
  const settle = round => {
    if (round.ended || round.waiting.size) return
    round.ended = true
    if (live() && (round.started || round.always)) {
      post({ type: 'images', loaded: round.loaded, failed: round.failed, bytes: round.bytes, ms: performance.now() - round.t0, slides: [...round.slides] })
    }
    round.resolve()
  }
  const unqueue = () => {
    for (const { img, round } of queue.splice(0)) {
      round.waiting.delete(img.media)
      settle(round)
    }
  }
  const pump = () => {
    if (!live()) unqueue()
    while (running < limit && queue.length) {
      const { img, round } = queue.shift()
      started.add(img.media)
      running++
      round.started++
      fetchImage(img, opts).then(n => {
        if (n === null) {
          round.failed++
        } else {
          round.loaded++
          round.bytes += n
          for (const s of img.slides || []) round.slides.add(s)
        }
      }).finally(() => {
        running--
        round.waiting.delete(img.media)
        settle(round)
        pump()
      })
    }
  }
  // Fetch the pictures `slides` use that haven't started, in that order, ahead of anything queued.
  const want = (slides, always = false) => {
    const round = newRound(always)
    const picks = []
    if (live()) {
      for (const s of slides) {
        for (const img of all) if (img.slides.includes(s) && !started.has(img.media) && !picks.includes(img)) picks.push(img)
      }
    }
    // The old window's queue goes: what the new window needs is queued again below, first.
    unqueue()
    for (const img of picks) round.waiting.add(img.media)
    queue = picks.map(img => ({ img, round }))
    settle(round)
    pump()
    return round.done
  }

  const [start] = deck.position()
  await want([start], true)
  let at = null
  return slide => {
    if (slide === at) return Promise.resolve()
    at = slide
    return want(windowSlides(order, slide, window))
  }
}

// Speaker notes of another deck by file slide id, for a presenter on the attendee copy. The download
// doesn't hold the queue, so the deck on screen keeps answering jumps and resizes; only reading the
// deck (wasm, in this thread) waits its turn. Never fatal. Replies carry the request's id.
async function startNotes ({ url, bytes, id }, { fetchFn, enqueue, notesOf, post }) {
  try {
    const buf = bytes || await fetchFn(url).then(r => {
      if (!r.ok) throw new Error(`could not download the notes (${r.status})`)
      return r.arrayBuffer()
    })
    await enqueue(() => post({ type: 'notes', id, notes: notesOf(new Uint8Array(buf)) }))
  } catch (err) {
    post({ type: 'notesError', id, message: String(err && err.message ? err.message : err) })
  }
}

async function handle (m) {
  try {
    switch (m.type) {
      case 'init': await init(m); break
      case 'open': await open(m); break
      case 'resize': if (player) { player.resize(m.width); schedule() } break
      // Links, Back, clicks and a late joiner's catch-up all move the deck through these two.
      case 'jump': if (player) { player.jump(m.slide, m.step); schedule(); showImages() } break
      case 'advance': if (player) { player.advance(m.slide, m.step, now()); schedule(); showImages() } break
    }
  } catch (err) {
    fail(err, m.type === 'init')
  }
}

// Messages run one after the other: an `open` sent right after `init` waits for the module. A task
// that throws leaves the queue running for the ones after it.
let queue = Promise.resolve()
function enqueue (task) {
  const run = queue.then(task)
  queue = run.catch(() => {})
  return run
}

if (typeof module === 'object' && module.exports) {
  // Node, for the tests (worker.test.js).
  module.exports = { familyKey, pickFace, loadFonts, MAX_FETCHES, startNotes, enqueue, answerLinkAt, fetchImage, openImages, windowSlides, IMAGE_WINDOW, MAX_DECK_IMAGE_BYTES, mediaUrl, readCapped, MAX_IMAGE_BYTES, MAX_IMAGE_FETCHES, IMAGE_TIMEOUT_MS }
} else {
  // An `open`'s download starts at once, alongside the module's; so does a notes download.
  self.onmessage = ({ data }) => {
    if (data.type === 'open' && data.url && !data.bytes) {
      data.download = fetch(data.url)
      data.download.catch(() => {})
    }
    if (data.type === 'notes') {
      startNotes(data, { fetchFn: fetch, enqueue, notesOf: bytes => wasm_bindgen.WebPlayer.notesOf(bytes), post })
      return
    }
    if (data.type === 'linkAt') {
      // A hover or a click waits for nothing: the answer is the deck on screen's, now.
      const failed = err => {
        player = null
        fail(err, true)
      }
      answerLinkAt(data, { linkAt: (x, y) => (ready && player ? player.linkAt(x, y) : null), post, failed })
      return
    }
    enqueue(() => handle(data))
  }
}
