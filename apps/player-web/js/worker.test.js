// The worker's font loading, run with `node --test apps/player-web/js/worker.test.js`.
const test = require('node:test')
const assert = require('node:assert/strict')

const { familyKey, pickFace, loadFonts, MAX_FETCHES, startNotes, enqueue, answerLinkAt, fetchImage, openImages, windowSlides, IMAGE_WINDOW, MAX_DECK_IMAGE_BYTES, MAX_IMAGE_BYTES, mediaUrl, MAX_IMAGE_FETCHES, readCapped } = require('./worker.js')

const BASE = 'https://fonts.example/'

// A font server holding `families` ({key: family.json}); every file is its own name as bytes.
function server (families, { fail = [] } = {}) {
  const asked = []
  const fetch = async url => {
    asked.push(url)
    const path = url.slice(BASE.length)
    const [, key, file] = path.split('/')
    const ok = !fail.includes(path) && families[key] && (file === 'family.json' || families[key].faces.some(f => f.file === file))
    if (!ok) return { ok: false, status: 403 }
    return {
      ok: true,
      json: async () => families[key],
      arrayBuffer: async () => new TextEncoder().encode(file).buffer,
    }
  }
  return { fetch, asked }
}

const face = (key, weight, italic = false) => ({ weight, italic, file: `${key}-${weight}${italic ? 'italic' : ''}.ttf` })
const family = (name, faces) => ({ family: name, key: familyKey(name).replace(/-/g, ' '), category: 'sans-serif', faces })
const text = bytes => new TextDecoder().decode(bytes)

test('family keys are lowercase with hyphens', () => {
  assert.equal(familyKey('  Open   Sans '), 'open-sans')
})

test('the face picked is the closest weight in the asked style', () => {
  const faces = [face('m', 300), face('m', 400), face('m', 700), face('m', 400, true)]
  assert.equal(pickFace(faces, 300, false).file, 'm-300.ttf')
  assert.equal(pickFace(faces, 600, false).file, 'm-700.ttf')
  assert.equal(pickFace(faces, 700, true).file, 'm-400italic.ttf')
  assert.equal(pickFace([face('m', 400)], 400, true).file, 'm-400.ttf', 'no italic: the upright face')
  assert.equal(pickFace([], 400, false), null)
})

test('each request gets the first candidate the server has, under the deck family name', async () => {
  const { fetch } = server({
    carlito: family('Carlito', [face('carlito', 400), face('carlito', 700)]),
    tinos: family('Tinos', [face('tinos', 400)]),
  })
  const got = await loadFonts([
    { family: 'Calibri', weight: 700, italic: false, candidates: ['Calibri', 'Carlito', 'Arimo'] },
    { family: 'Old Foundry Serif', weight: 400, italic: false, candidates: ['Old Foundry Serif', 'Tinos'] },
  ], BASE, fetch)
  assert.deepEqual(got.map(g => [g.family, g.from, text(g.bytes)]), [
    ['Calibri', 'Carlito', 'carlito-700.ttf'],
    ['Old Foundry Serif', 'Tinos', 'tinos-400.ttf'],
  ])
})

test('a family is looked up once however many requests name it', async () => {
  const { fetch, asked } = server({ carlito: family('Carlito', [face('carlito', 400), face('carlito', 700)]) })
  await loadFonts([
    { family: 'Calibri', weight: 400, italic: false, candidates: ['Calibri', 'Carlito'] },
    { family: 'Calibri', weight: 700, italic: false, candidates: ['Calibri', 'Carlito'] },
  ], BASE, fetch)
  assert.equal(asked.filter(u => u.endsWith('calibri/family.json')).length, 1)
  assert.equal(asked.filter(u => u.endsWith('carlito/family.json')).length, 1)
})

test('a failed file moves on to the next candidate, and nothing found is left out', async () => {
  const { fetch } = server({
    montserrat: family('Montserrat', [face('montserrat', 300)]),
    inter: family('Inter', [face('inter', 400)]),
  }, { fail: ['families/montserrat/montserrat-300.ttf'] })
  const got = await loadFonts([
    { family: 'Montserrat Light', weight: 300, italic: false, candidates: ['Montserrat Light', 'Montserrat', 'Inter'] },
    { family: 'Nowhere', weight: 400, italic: false, candidates: ['Nowhere'] },
  ], BASE, fetch)
  assert.deepEqual(got.map(g => [g.family, g.from]), [['Montserrat Light', 'Inter']])
})

test('a fetch that throws is a miss, not a crash', async () => {
  const got = await loadFonts([{ family: 'Calibri', weight: 400, italic: false, candidates: ['Carlito'] }], BASE, async () => { throw new Error('offline') })
  assert.deepEqual(got, [])
})

test('a family name is one URL segment, so a deck cannot point fetches elsewhere', async () => {
  assert.equal(familyKey('../../api/private?x='), '..%2F..%2Fapi%2Fprivate%3Fx%3D')
  assert.equal(familyKey('M+ 1p'), 'm%2B-1p')
  const { fetch, asked } = server({})
  await loadFonts([{ family: 'x', weight: 400, italic: false, candidates: ['../../api/private?x=', '..', '.', ' '] }], BASE, fetch)
  assert.deepEqual(asked, [`${BASE}families/..%2F..%2Fapi%2Fprivate%3Fx%3D/family.json`])
})

test('at most a few fetches run at once', async () => {
  let inFlight = 0
  let most = 0
  const fetch = async () => {
    inFlight++
    most = Math.max(most, inFlight)
    await new Promise(resolve => setTimeout(resolve, 5))
    inFlight--
    return { ok: false, status: 403 }
  }
  const requests = Array.from({ length: 40 }, (_, i) => ({ family: `F${i}`, weight: 400, italic: false, candidates: [`F${i}`, `G${i}`] }))
  await loadFonts(requests, BASE, fetch)
  assert.ok(most <= MAX_FETCHES, `${most} fetches at once`)
  assert.ok(most > 1, 'still in parallel')
})

test('a notes download runs outside the worker queue; only the read joins it, and replies carry the id', async () => {
  let release
  const download = new Promise(resolve => { release = resolve })
  const enqueued = []
  const posted = []
  const done = startNotes({ type: 'notes', url: 'https://cdn.example/o.pptx', id: 7 }, {
    fetchFn: async () => ({ ok: true, arrayBuffer: () => download }),
    enqueue: task => { enqueued.push(task); return task() },
    notesOf: bytes => [{ fileId: 256, notes: `read ${bytes.length} bytes` }],
    post: m => posted.push(m),
  })
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(enqueued.length, 0, 'nothing queued while the download runs')
  release(new ArrayBuffer(3))
  await done
  assert.equal(enqueued.length, 1)
  assert.deepEqual(posted, [{ type: 'notes', id: 7, notes: [{ fileId: 256, notes: 'read 3 bytes' }] }])
})

test('a failed notes download or read answers notesError with the id, never fatal', async () => {
  const posted = []
  const deps = { enqueue: task => task(), notesOf: () => { throw new Error('unreadable') }, post: m => posted.push(m) }
  await startNotes({ type: 'notes', url: 'u', id: 1 }, { ...deps, fetchFn: async () => ({ ok: false, status: 403 }) })
  await startNotes({ type: 'notes', bytes: new ArrayBuffer(1), id: 2 }, { ...deps, fetchFn: async () => { throw new Error('no fetch') } })
  assert.deepEqual(posted.map(m => [m.type, m.id]), [['notesError', 1], ['notesError', 2]])
  assert.match(posted[0].message, /403/)
  assert.match(posted[1].message, /unreadable/)
})

test('a task that throws in the queue does not stop the ones after it', async () => {
  const ran = []
  await assert.rejects(enqueue(() => { throw new Error('bad deck') }), /bad deck/)
  await enqueue(() => ran.push('jump'))
  assert.deepEqual(ran, ['jump'])
})

// A link as WebPlayer.linkAt gives it.
const LINK = { target: { type: 'url', url: 'https://example.com' }, shape: 4, text: false, rect: [0.1, 0.1, 0.2, 0.1], quad: [[0.1, 0.1], [0.3, 0.1], [0.3, 0.2], [0.1, 0.2]], tooltip: '', label: 'Docs' }

test('a hit test goes from the page to the worker and back, matched by id', async () => {
  const { LinkRequests } = await import('./player.js')
  const requests = new LinkRequests()
  const asked = []
  // The page's postMessage reaches the worker, whose reply reaches the page.
  const worker = {
    postMessage: m => answerLinkAt(m, {
      linkAt: (x, y) => { asked.push([x, y]); return x < 0.5 ? LINK : null },
      post: reply => queueMicrotask(() => requests.settle(reply)),
    }),
  }
  const [hit, miss] = await Promise.all([requests.ask(worker, 0.2, 0.15), requests.ask(worker, 0.9, 0.9)])
  assert.deepEqual(hit, LINK)
  assert.equal(miss, null)
  assert.deepEqual(asked, [[0.2, 0.15], [0.9, 0.9]])
})

test('a hit test is always answered: null for a point that is not one, or when the module traps', () => {
  const posted = []
  const failures = []
  const post = m => posted.push(m)
  answerLinkAt({ id: 1, x: NaN, y: 0.5 }, { linkAt: () => LINK, post })
  answerLinkAt({ id: 2, x: '0.5', y: 0.5 }, { linkAt: () => LINK, post })
  answerLinkAt({ id: 3, x: 0.5, y: 0.5 }, { linkAt: () => { throw new Error('unreachable executed') }, post, failed: e => failures.push(e.message) })
  answerLinkAt({ id: 4, x: 0.5, y: 0.5 }, { linkAt: () => undefined, post })
  assert.deepEqual(posted, [1, 2, 3, 4].map(id => ({ type: 'linkAt', id, link: null })))
  assert.deepEqual(failures, ['unreachable executed'])
})

test('replies to hit tests nobody waits for are ignored, and a restart answers the rest with null', async () => {
  const { LinkRequests } = await import('./player.js')
  const requests = new LinkRequests(2)
  const sent = []
  const worker = { postMessage: m => sent.push(m) }
  const a = requests.ask(worker, 0.1, 0.1)
  const b = requests.ask(worker, 0.2, 0.2)
  const c = requests.ask(worker, 0.3, 0.3)
  assert.equal(await a, null, 'too many at once: the oldest gives way')
  requests.settle({ type: 'linkAt', id: 999, link: LINK })
  requests.settle({ type: 'linkAt', id: sent[1].id, link: LINK })
  assert.deepEqual(await b, LINK)
  requests.cancel()
  assert.equal(await c, null)
})

// Linked pictures: pictures whose bytes live outside the deck, fetched from the host's media
// prefix only.

const IMG_BASE = 'https://cdn.example/decks/42/'

test('only https URLs under the media prefix may be fetched', () => {
  assert.equal(mediaUrl(`${IMG_BASE}a.png`, IMG_BASE), `${IMG_BASE}a.png`)
  assert.equal(mediaUrl(`${IMG_BASE}deep/a.png?sig=1`, IMG_BASE), `${IMG_BASE}deep/a.png?sig=1`)
  assert.equal(mediaUrl('https://CDN.Example/decks/42/a.png', IMG_BASE), `${IMG_BASE}a.png`, 'the host ignores case')
  assert.equal(mediaUrl(`${IMG_BASE}a.png#x`, IMG_BASE), `${IMG_BASE}a.png`, 'a fragment is dropped')
  assert.equal(mediaUrl('https://cdn.example/decks/42/a.png', 'https://cdn.example/decks/42'), `${IMG_BASE}a.png`, 'a prefix without its slash')
  for (const bad of [
    'file:///C:/Users/someone/Pictures/photo.png',
    'C:\\Users\\someone\\photo.png',
    'photo.png',
    '',
    'http://cdn.example/decks/42/a.png',
    'https://cdn.example/decks/4/a.png',
    'https://cdn.example.evil.org/decks/42/a.png',
    'https://other.example/decks/42/a.png',
    'https://user:pass@cdn.example/decks/42/a.png',
    `${IMG_BASE}../43/a.png`,
    `${IMG_BASE}%2e%2e/43/a.png`,
    `${IMG_BASE}a%2F..%2Fb.png`,
    `${IMG_BASE}a b.png`,
    IMG_BASE,
    `${IMG_BASE}${'a'.repeat(2048)}`,
  ]) assert.equal(mediaUrl(bad, IMG_BASE), null, bad)
  for (const base of ['', 'http://cdn.example/', 'https://cdn.example/x?y', 'https://u@cdn.example/', null]) {
    assert.equal(mediaUrl(`${IMG_BASE}a.png`, base), null, `base ${base}`)
  }
})

// A deck of linked pictures as WebPlayer reports them, with the player calls the worker makes.
function deck (images, { slide = 0, onScreen = () => true, refuse = null } = {}) {
  const set = []
  return {
    set,
    moveTo: s => { slide = s },
    position: () => [slide, 0],
    linkedImages: base => (base ? images : []),
    setLinkedImage: (media, bytes) => {
      if (refuse && refuse(media)) throw new Error('undecodable')
      set.push([media, bytes.length])
      return onScreen(media)
    },
  }
}

const image = (media, url, slides) => ({ media, url: `${IMG_BASE}${url}`, contentType: 'image/png', slides, loaded: false })

// A media server; `hold` keeps a URL's fetch pending until its resolver is called.
function images ({ fail = [], hold = [], bytes = 4 } = {}) {
  const asked = []
  const holds = new Map()
  const fetch = async (url, opts = {}) => {
    asked.push({ url, credentials: opts.credentials, redirect: opts.redirect })
    if (hold.includes(url)) {
      await new Promise((resolve, reject) => {
        holds.set(url, resolve)
        // As fetch does: an aborted request rejects rather than answering.
        opts.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }
    if (fail.includes(url)) return { ok: false, status: 404 }
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(bytes) }
  }
  return { fetch, asked, release: url => holds.get(url)?.() }
}

// Settle every promise that can settle now: pending fetches answer, rounds report.
const flush = () => new Promise(resolve => setImmediate(resolve))

// openImages on `player` with `server`, posting into `posted`; `order` defaults to slides 0..n-1.
function open (player, server, { posted = [], order = Array.from({ length: 30 }, (_, i) => i), current = () => player, ...rest } = {}) {
  return openImages({ deck: player, base: IMG_BASE, post: m => posted.push(m), current, schedule: () => {}, order, fetchFn: server.fetch, ...rest })
}
const urls = server => server.asked.map(a => a.url.slice(IMG_BASE.length))
const rounds = posted => posted.filter(m => m.type === 'images')

test('the window is the slide, the next two and the previous one, in show order', () => {
  assert.deepEqual(IMAGE_WINDOW, { ahead: 2, behind: 1 })
  const order = [0, 1, 2, 4, 5, 6] // 3 is hidden
  assert.deepEqual(windowSlides(order, 2), [2, 4, 5, 1], 'a hidden slide is skipped, not counted')
  assert.deepEqual(windowSlides(order, 0), [0, 1, 2], 'nothing before the first')
  assert.deepEqual(windowSlides(order, 6), [6, 5], 'nothing after the last')
  assert.deepEqual(windowSlides([7, 2, 9, 4], 2), [2, 9, 4, 7], 'a custom show’s order, not the indexes')
  assert.deepEqual(windowSlides(order, 3), [3], 'a hidden slide jumped to is its own window')
  assert.deepEqual(windowSlides(order, 2, { ahead: 0, behind: 0 }), [2])
})

test('the first frame waits only for the starting slide’s pictures, then its window follows', async () => {
  const all = [image(1, 'a.png', [0]), image(2, 'b.png', [1, 2]), image(3, 'c.png', [0, 3]), image(4, 'd.png', [3]), image(5, 'e.png', [4])]
  const player = deck(all)
  const server = images()
  const posted = []
  const show = await open(player, server, { posted })
  assert.deepEqual(urls(server), ['a.png', 'c.png'], 'only slide 0’s')
  assert.deepEqual(posted, [{ type: 'images', loaded: 2, failed: 0, bytes: 8, ms: posted[0].ms, slides: [0, 3] }])
  await show(0)
  assert.deepEqual(urls(server).slice(2), ['b.png'], 'slides 1 and 2; c.png is already in; d.png (slide 3) is outside the window')
  assert.deepEqual(player.set.map(s => s[0]), [1, 3, 2])
  assert.equal(rounds(posted).length, 2)
  assert.deepEqual(rounds(posted)[1].slides, [1, 2])
})

test('a start part-way through prefetches the slide before it too', async () => {
  const all = [image(1, 'a.png', [4]), image(2, 'b.png', [5]), image(3, 'c.png', [6]), image(4, 'd.png', [7]), image(5, 'e.png', [3]), image(6, 'f.png', [2])]
  const player = deck(all, { slide: 4 })
  const server = images()
  const show = await open(player, server)
  await show(4)
  assert.deepEqual(urls(server), ['a.png', 'b.png', 'c.png', 'e.png'], 'the slide, the next two, then the one before')
})

test('without a media prefix nothing is ever fetched, whatever the deck names', async () => {
  const player = deck([image(1, 'a.png', [0])])
  const server = images()
  const posted = []
  const show = await open(player, server, { posted, base: null })
  await show(0)
  await show(1)
  assert.deepEqual(server.asked, [])
  assert.deepEqual(player.set, [])
  assert.deepEqual(posted, [{ type: 'images', loaded: 0, failed: 0, bytes: 0, ms: posted[0].ms, slides: [] }])
})

test('moving forward loads the next window and nothing beyond it', async () => {
  const all = Array.from({ length: 10 }, (_, i) => image(i, `s${i}.png`, [i]))
  const player = deck(all)
  const server = images()
  const posted = []
  const show = await open(player, server, { posted })
  await show(0)
  assert.deepEqual(urls(server), ['s0.png', 's1.png', 's2.png'])
  await show(1)
  assert.deepEqual(urls(server), ['s0.png', 's1.png', 's2.png', 's3.png'], 'only slide 3 is new')
  await show(2)
  assert.deepEqual(urls(server).slice(4), ['s4.png'])
  await show(2)
  assert.equal(server.asked.length, 5, 'a move within the slide fetches nothing')
  assert.deepEqual(rounds(posted).map(r => r.slides), [[0], [1, 2], [3], [4]], 'one images message per window with something new')
})

test('a hidden slide is not counted in the window', async () => {
  const all = [image(1, 'a.png', [0]), image(2, 'b.png', [1]), image(3, 'c.png', [3]), image(4, 'd.png', [4])]
  const player = deck(all)
  const server = images()
  const show = await open(player, server, { order: [0, 1, 3, 4] })
  await show(0)
  assert.deepEqual(urls(server), ['a.png', 'b.png', 'c.png'], 'the next two slides of the show are 1 and 3')
})

test('a picture several slides use is fetched once', async () => {
  const logo = image(1, 'logo.png', [0, 1, 2, 3, 4, 5, 6])
  const all = [logo, image(2, 'b.png', [3]), image(3, 'c.png', [6])]
  const player = deck(all)
  const server = images()
  const show = await open(player, server)
  const seen = []
  for (const s of [0, 1, 2, 3, 4, 5, 6, 0, 6]) {
    await show(s)
    seen.push(urls(server).join(' '))
  }
  assert.deepEqual(seen, [
    'logo.png',
    'logo.png b.png',
    'logo.png b.png',
    'logo.png b.png',
    'logo.png b.png c.png',
    'logo.png b.png c.png',
    'logo.png b.png c.png',
    'logo.png b.png c.png',
    'logo.png b.png c.png',
  ], 'each window adds only its new pictures; the logo every slide uses is fetched once')
  assert.deepEqual(player.set.map(s => s[0]), [1, 2, 3])
})

test('a far jump fetches the new slide’s pictures first and drops the old window’s queue', async () => {
  // Slide 1 has six pictures: four start, two wait for a slot. Slide 20 has two.
  const near = Array.from({ length: 6 }, (_, i) => image(10 + i, `near${i}.png`, [1]))
  const far = [image(30, 'far0.png', [20]), image(31, 'far1.png', [21])]
  const held = near.slice(0, 4).map(m => m.url)
  const player = deck([...near, ...far])
  const server = images({ hold: held })
  const posted = []
  const show = await open(player, server, { posted })
  const old = show(0)
  await flush()
  assert.deepEqual(urls(server), ['near0.png', 'near1.png', 'near2.png', 'near3.png'], 'four at once')
  const jump = show(20)
  for (const u of held) server.release(u)
  await Promise.all([old, jump])
  assert.deepEqual(urls(server).slice(4), ['far0.png', 'far1.png'], 'the new slide first, then its window; near4 and near5 never start')
  assert.deepEqual(player.set.map(s => s[0]), [10, 11, 12, 13, 30, 31], 'fetches already running finished')
  assert.deepEqual(rounds(posted).slice(1).map(r => r.loaded), [4, 2], 'each round counts what it started')
  await show(1)
  assert.deepEqual(urls(server).slice(6), ['near4.png', 'near5.png'], 'dropped, not lost: coming back fetches them')
})

test('a failed picture is not fetched again on later moves', async () => {
  const all = [image(1, 'a.png', [0]), image(2, 'bad.png', [4, 5])]
  const player = deck(all)
  const server = images({ fail: [`${IMG_BASE}bad.png`] })
  const posted = []
  const show = await open(player, server, { posted })
  await show(0)
  assert.deepEqual(urls(server), ['a.png'], 'slide 4 is outside the first window')
  for (const s of [2, 3, 4, 5, 4, 0, 4, 5]) await show(s)
  assert.deepEqual(urls(server), ['a.png', 'bad.png'], 'tried once, when its window came, never again')
  assert.deepEqual(posted.filter(m => m.type === 'error').map(m => [m.message, m.url.slice(IMG_BASE.length), m.reason, m.fatal]), [['image-unavailable', 'bad.png', 'status 404', false]])
})

test('one deck budget holds across every window', async () => {
  // 30 MiB each, under the per-picture cap: eight fit in the deck's 256 MiB, the ninth would not.
  const size = 30 * 1024 * 1024
  const all = Array.from({ length: 12 }, (_, i) => image(i, `s${i}.png`, [i]))
  const player = deck(all)
  const server = images({ bytes: size })
  const posted = []
  const show = await open(player, server, { posted })
  const asked = []
  for (let s = 0; s < 12; s++) {
    await show(s)
    asked.push(server.asked.length)
  }
  assert.ok(8 * size <= MAX_DECK_IMAGE_BYTES && 9 * size > MAX_DECK_IMAGE_BYTES)
  assert.deepEqual(asked, [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 12, 12], 'one more slide’s picture per move')
  assert.deepEqual(player.set.map(s => s[0]), [0, 1, 2, 3, 4, 5, 6, 7], 'spread over several windows, still one budget')
  assert.deepEqual(posted.filter(m => m.type === 'error').map(m => m.reason), ['deck-budget', 'deck-budget', 'deck-budget', 'deck-budget'])
  assert.equal(rounds(posted).reduce((n, r) => n + r.bytes, 0), 8 * size)
})

test('a failed fetch, a refused picture and a timeout are reported and leave the others', async () => {
  const all = [image(1, 'a.png', [0]), image(2, 'b.png', [0]), image(3, 'c.png', [0]), image(4, 'slow.png', [0])]
  const player = deck(all, { refuse: media => media === 3 })
  const server = images({ fail: [`${IMG_BASE}b.png`], hold: [`${IMG_BASE}slow.png`] })
  const posted = []
  await open(player, server, { posted, timeoutMs: 20 })
  const [got] = rounds(posted)
  assert.equal(got.loaded, 1)
  assert.equal(got.failed, 3)
  assert.equal(got.bytes, 4)
  assert.ok(got.ms >= 0)
  assert.deepEqual(posted.filter(m => m.type === 'error').map(f => [f.message, f.url.slice(IMG_BASE.length), f.slide, f.reason, f.fatal]), [
    ['image-unavailable', 'b.png', 0, 'status 404', false],
    ['image-unavailable', 'c.png', 0, 'undecodable', false],
    ['image-unavailable', 'slow.png', 0, 'timeout', false],
  ])
  assert.deepEqual(player.set.map(s => s[0]), [1])
})

test('at most a few pictures are fetched at once, across windows', async () => {
  let inFlight = 0
  let most = 0
  const fetch = async () => {
    inFlight++
    most = Math.max(most, inFlight)
    await new Promise(resolve => setTimeout(resolve, 5))
    inFlight--
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) }
  }
  const all = Array.from({ length: 40 }, (_, i) => image(i, `p${i}.png`, [i % 4]))
  const player = deck(all)
  const posted = []
  const show = await open(player, { fetch }, { posted })
  await Promise.all([show(0), show(1), show(2)])
  assert.equal(rounds(posted).reduce((n, r) => n + r.loaded, 0), 40)
  assert.ok(most <= MAX_IMAGE_FETCHES, `${most} fetches at once`)
  assert.ok(most > 1, 'still in parallel')
})

test('fetches carry the credentials mode the host asked for, and none by default', async () => {
  const server = images()
  await open(deck([image(1, 'a.png', [0])]), server, { credentials: 'include' })
  await open(deck([image(1, 'a.png', [0])]), server)
  assert.deepEqual(server.asked.map(a => a.credentials), ['include', undefined])
})

test('a redirect is never followed, so a fetch cannot leave the media prefix', async () => {
  const failed = []
  // As fetch does with redirect: 'error': a redirect response rejects.
  const fetchFn = async (url, opts) => {
    assert.equal(opts.redirect, 'error')
    throw new TypeError('Failed to fetch')
  }
  const got = await fetchImage(image(1, 'a.png', [0]), { fetchFn, setImage: () => assert.fail('no bytes'), failed: f => failed.push(f) })
  assert.equal(got, null)
  assert.equal(failed[0].url, `${IMG_BASE}a.png`)
  const server = images()
  await open(deck([image(1, 'a.png', [0])]), server)
  assert.deepEqual(server.asked.map(a => a.redirect), ['error'])
})

// A response whose body arrives in `chunks` chunks of `size` bytes, with an optional
// Content-Length; `read` counts the chunks read and `cancelled` says whether reading stopped.
function streamed (chunks, size, length = null) {
  const state = { read: 0, cancelled: false }
  let i = 0
  return {
    state,
    ok: true,
    headers: { get: k => (k === 'content-length' && length !== null ? String(length) : null) },
    body: {
      getReader: () => ({
        read: async () => (i++ < chunks ? (state.read++, { done: false, value: new Uint8Array(size) }) : { done: true }),
        cancel: async () => { state.cancelled = true },
      }),
    },
    arrayBuffer: () => assert.fail('the body is streamed, never buffered whole'),
  }
}

test('a body is read under the per-picture cap and dropped as soon as it passes it', async () => {
  const ok = await readCapped(streamed(3, 10), 30, { left: 100 })
  assert.equal(ok.byteLength, 30)
  const big = streamed(1000, 10)
  await assert.rejects(readCapped(big, 25, { left: 100 }), /too-large/)
  assert.equal(big.state.read, 3, 'stopped at the chunk that passed the cap, not at the end')
  assert.ok(big.state.cancelled)
  await assert.rejects(readCapped(streamed(1, 10, 9999), 25, { left: 100 }), /too-large/, 'a declared length over the cap is refused unread')
})

test('the deck’s total budget is spent as bytes arrive and refuses the picture that would pass it', async () => {
  const budget = { left: 25 }
  await readCapped(streamed(2, 10), 100, budget)
  assert.equal(budget.left, 5)
  await assert.rejects(readCapped(streamed(1, 10), 100, budget), /deck-budget/)
  assert.equal(budget.left, 5, 'a refused picture spends nothing')
})

test('an oversized picture is reported, and the others still load', async () => {
  const all = [image(1, 'big.png', [0]), image(2, 'a.png', [0])]
  const player = deck(all)
  const fetch = async url => (url.endsWith('big.png') ? streamed(MAX_IMAGE_BYTES / 1024 + 1, 1024) : streamed(1, 16))
  const posted = []
  await open(player, { fetch }, { posted })
  assert.deepEqual(posted.filter(m => m.type === 'error').map(f => f.reason), ['too-large'])
  assert.deepEqual(player.set.map(s => s[0]), [2])
  assert.equal(rounds(posted)[0].bytes, 16)
})

test('bytes that arrive after the deck was replaced are dropped, and nothing more starts', async () => {
  const all = [image(1, 'a.png', [0]), image(2, 'b.png', [1]), image(3, 'c.png', [2]), image(4, 'd.png', [3])]
  const player = deck(all)
  let current = player
  const server = images({ hold: [`${IMG_BASE}b.png`] })
  const posted = []
  const show = await open(player, server, { posted, current: () => current, limit: 1 })
  const window = show(0)
  await flush()
  assert.deepEqual(urls(server), ['a.png', 'b.png'], 'b.png is running, c.png waits')
  current = deck([])
  server.release(`${IMG_BASE}b.png`)
  await window
  await show(3)
  assert.deepEqual(player.set.map(s => s[0]), [1], 'slide 0’s picture only')
  assert.deepEqual(urls(server), ['a.png', 'b.png'], 'nothing started after the deck was replaced')
  assert.equal(rounds(posted).length, 1, 'and nothing reported for it')
})
