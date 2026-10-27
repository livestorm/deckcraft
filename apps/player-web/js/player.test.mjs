// The page side's trim and loop rule, run with `node --test apps/player-web/js/player.test.mjs`.
import test from 'node:test'
import assert from 'node:assert/strict'

import { trimStep } from './player.js'

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
