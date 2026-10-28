// The worker's font loading, run with `node --test apps/player-web/js/worker.test.js`.
const test = require('node:test')
const assert = require('node:assert/strict')

const { familyKey, pickFace, loadFonts, MAX_FETCHES, startNotes, enqueue } = require('./worker.js')

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
