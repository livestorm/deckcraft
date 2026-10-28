// The page side's trim and loop rule, run with `node --test apps/player-web/js/player.test.mjs`.
import test from 'node:test'
import assert from 'node:assert/strict'

import { NotesRequest, trimStep } from './player.js'

const DURATION = 100

test('an untrimmed clip is left to the media element', () => {
  assert.equal(trimStep({ loop: true }, 99.9, DURATION), null)
  assert.equal(trimStep({}, 50, DURATION), null)
})

test('a trimmed clip plays on until its trim end', () => {
  const clip = { trimStartMs: 2000, trimEndMs: 10000 }
  assert.equal(trimStep(clip, 50, DURATION), null)
  assert.equal(trimStep(clip, 89.9, DURATION), null)
})

test('past its trim end, a trimmed clip stops where it is, or loops back to its trim start', () => {
  assert.deepEqual(trimStep({ trimStartMs: 2000, trimEndMs: 10000 }, 90, DURATION), { stop: true })
  assert.deepEqual(trimStep({ trimStartMs: 2000, trimEndMs: 10000, loop: true }, 90.2, DURATION), { seek: 2 })
})

test('a clip trimmed only at the start loops back to that start when it ends', () => {
  const clip = { trimStartMs: 2000, loop: true }
  assert.equal(trimStep(clip, 50, DURATION), null)
  assert.deepEqual(trimStep(clip, DURATION, DURATION), { seek: 2 })
})

test('before the duration is known, nothing is decided', () => {
  assert.equal(trimStep({ trimStartMs: 2000, trimEndMs: 10000, loop: true }, 5, NaN), null)
})

// A worker that records what it was sent.
const fakeWorker = () => ({ sent: [], postMessage (m) { this.sent.push(m) } })

test('notesOf asks the worker and resolves to notes by file id', async () => {
  const worker = fakeWorker()
  const req = new NotesRequest()
  const pending = req.ask(worker, 'https://cdn.example/original.pptx')
  assert.deepEqual(worker.sent, [{ type: 'notes', url: 'https://cdn.example/original.pptx' }])
  req.settle({ type: 'notes', notes: [{ fileId: 256, notes: 'One' }, { fileId: 259, notes: 'Four' }] })
  const notes = await pending
  assert.equal(notes.get(259), 'Four')
  assert.equal(notes.size, 2)
})

test('a notesError rejects, and later replies with nothing pending are ignored', async () => {
  const req = new NotesRequest()
  const pending = req.ask(fakeWorker(), 'u')
  req.settle({ type: 'notesError', message: 'unreadable' })
  await assert.rejects(pending, /unreadable/)
  assert.doesNotThrow(() => req.settle({ type: 'notes', notes: [] }))
})

test('a second request replaces the first, and cancel rejects what is pending', async () => {
  const req = new NotesRequest()
  const first = req.ask(fakeWorker(), 'a')
  const second = req.ask(fakeWorker(), 'b')
  await assert.rejects(first, /replaced/)
  req.cancel()
  await assert.rejects(second, /closed/)
})
