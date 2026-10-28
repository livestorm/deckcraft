// DeckCraft player worker: owns the deck and the canvas; the page sends positions and gets
// pictures drawn, media clips and media cues back.
//
// In:  {type: 'init', glueUrl, wasmUrl, canvas: OffscreenCanvas, fonts: [url], fontsBase}
//      {type: 'open', url} | {type: 'open', bytes: ArrayBuffer}
//      {type: 'resize', width}
//      {type: 'jump', slide, step} | {type: 'advance', slide, step}
//      {type: 'notes', url, id} | {type: 'notes', bytes, id}: another deck's speaker notes. The
//        download runs alongside everything else; only reading the deck joins the queue
// Out: {type: 'initialized', loadMs}
//      {type: 'fonts', loaded: [{family, from}], missing: [family]} when fontsBase is set
//      {type: 'ready', info, media, openMs}
//      {type: 'state', slide, step, animating}
//      {type: 'cues', cues: [{shape, action}]}
//      {type: 'metrics', frameMs, width, height}
//      {type: 'notes', id, notes: [{fileId, notes}]} | {type: 'notesError', id, message}
//      {type: 'error', message, fatal}

/* global wasm_bindgen */ // declared by deckcraft_player.js, imported below

let player = null
let canvas = null
let fontsBase = null
let ctx = null // 2D fallback when WebGL2 isn't available
let gl = null
let scheduled = false
let lastState = ''

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
  if (f.animating) schedule()
}

async function init ({ glueUrl, wasmUrl, canvas: c, fonts, fontsBase: fb }) {
  const t0 = performance.now()
  fontsBase = fb || null
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
  const media = player.media()
  post({ type: 'ready', info: player.info(), media, openMs: performance.now() - t0 }, media.map(m => m.data.buffer))
  lastState = ''
  schedule()
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
      case 'jump': if (player) { player.jump(m.slide, m.step); schedule() } break
      case 'advance': if (player) { player.advance(m.slide, m.step, now()); schedule() } break
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
  module.exports = { familyKey, pickFace, loadFonts, MAX_FETCHES, startNotes, enqueue }
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
    enqueue(() => handle(data))
  }
}
