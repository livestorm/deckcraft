// The worker's font loading, run with `node --test apps/player-web/js/`.
const test = require('node:test')
const assert = require('node:assert/strict')

const { familyKey, pickFace, loadFonts } = require('./worker.js')

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
