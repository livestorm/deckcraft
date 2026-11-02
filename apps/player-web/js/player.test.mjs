// The page side's trim and loop rule, run with `node --test apps/player-web/js/player.test.mjs`.
import test from 'node:test'
import assert from 'node:assert/strict'

import { DeckcraftPlayer, NotesRequest, YouTubeClip, loadYouTubeApi, trimStep, youtubeVideo } from './player.js'

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
  const [sent] = worker.sent
  assert.deepEqual(sent, { type: 'notes', url: 'https://cdn.example/original.pptx', id: sent.id })
  req.settle({ type: 'notes', id: sent.id, notes: [{ fileId: 256, notes: 'One' }, { fileId: 259, notes: 'Four' }] })
  const notes = await pending
  assert.equal(notes.get(259), 'Four')
  assert.equal(notes.size, 2)
})

test('a notesError rejects, and later replies with nothing pending are ignored', async () => {
  const req = new NotesRequest()
  const worker = fakeWorker()
  const pending = req.ask(worker, 'u')
  req.settle({ type: 'notesError', id: worker.sent[0].id, message: 'unreadable' })
  await assert.rejects(pending, /unreadable/)
  assert.doesNotThrow(() => req.settle({ type: 'notes', id: worker.sent[0].id, notes: [] }))
})

test('a second request replaces the first, and cancel rejects what is pending', async () => {
  const req = new NotesRequest()
  const first = req.ask(fakeWorker(), 'a')
  const second = req.ask(fakeWorker(), 'b')
  await assert.rejects(first, /replaced/)
  req.cancel()
  await assert.rejects(second, /closed/)
})

test('a reply to a replaced request is ignored: the newer one gets its own reply', async () => {
  const req = new NotesRequest()
  const worker = fakeWorker()
  req.ask(worker, 'a').catch(() => {})
  const b = req.ask(worker, 'b')
  const [a, bSent] = worker.sent
  assert.notEqual(a.id, bSent.id)
  req.settle({ type: 'notes', id: a.id, notes: [{ fileId: 1, notes: 'from a' }] })
  req.settle({ type: 'notes', id: bSent.id, notes: [{ fileId: 1, notes: 'from b' }] })
  assert.equal((await b).get(1), 'from b')
})

test('youtubeVideo finds the id in every form of YouTube link', () => {
  const id = 'dQw4w9WgXcQ'
  for (const url of [
    `https://www.youtube.com/embed/${id}?feature=oembed`,
    `https://www.youtube.com/watch?v=${id}&list=PL1`,
    `http://youtube.com/watch?feature=share&v=${id}`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/live/${id}`,
    `https://youtu.be/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`
  ]) assert.equal(youtubeVideo(url)?.id, id, url)
})

test('youtubeVideo reads start and end times', () => {
  const at = url => { const v = youtubeVideo(url); return [v.startMs, v.endMs] }
  assert.deepEqual(at('https://www.youtube.com/embed/dQw4w9WgXcQ'), [0, 0])
  assert.deepEqual(at('https://www.youtube.com/embed/dQw4w9WgXcQ?start=30&end=95'), [30000, 95000])
  assert.deepEqual(at('https://youtu.be/dQw4w9WgXcQ?t=90'), [90000, 0])
  assert.deepEqual(at('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s'), [90000, 0])
  assert.deepEqual(at('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1h0m2s'), [3602000, 0])
  assert.deepEqual(at('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=soon'), [0, 0])
})

test('youtubeVideo refuses other hosts, lookalikes, bad ids and garbage', () => {
  for (const url of [
    'https://vimeo.com/76979871',
    'https://www.youtube.com.example.com/embed/dQw4w9WgXcQ',
    'https://notyoutube.com/embed/dQw4w9WgXcQ',
    'https://www.youtube.com/embed/short',
    'https://www.youtube.com/embed/dQw4w9WgXcQ<x>',
    'https://www.youtube.com/channel/UC38IQsAvIsxxjztdMZQtwHA',
    'javascript:alert(1)//youtube.com/embed/dQw4w9WgXcQ',
    'file:///youtube.com/embed/dQw4w9WgXcQ',
    'not a url',
    '',
    undefined
  ]) assert.equal(youtubeVideo(url), null, String(url))
})

// A window whose document records the scripts added to it.
function fakeWindow () {
  const scripts = []
  return {
    scripts,
    document: { createElement: () => ({}), head: { append: s => scripts.push(s) } }
  }
}

test('loadYouTubeApi adds the script once and resolves when YouTube says it is ready', async () => {
  const win = fakeWindow()
  let earlier = 0
  win.onYouTubeIframeAPIReady = () => { earlier += 1 }
  const a = loadYouTubeApi(win)
  const b = loadYouTubeApi(win)
  assert.equal(win.scripts.length, 1)
  assert.equal(win.scripts[0].src, 'https://www.youtube.com/iframe_api')
  win.YT = { Player: function () {} }
  win.onYouTubeIframeAPIReady()
  assert.equal(await a, win.YT)
  assert.equal(await b, win.YT)
  assert.equal(earlier, 1, 'a handler already there still runs')
  assert.equal(await loadYouTubeApi(win), win.YT)
  assert.equal(win.scripts.length, 1)
})

test('loadYouTubeApi rejects when the script fails or never answers, and a later call tries again', async () => {
  const win = fakeWindow()
  const failed = loadYouTubeApi(win, 1000)
  win.scripts[0].onerror()
  await assert.rejects(failed, /youtube-unavailable/)
  await assert.rejects(loadYouTubeApi(win, 5), /youtube-unavailable/)
  assert.equal(win.scripts.length, 2, 'tried again')
})

// A YouTube IFrame API whose one player records its calls; `fire` plays YouTube's part.
const S = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 }
function fakeYouTube () {
  const yt = { PlayerState: S, made: null }
  yt.Player = function (target, opts) {
    const p = { target, opts, calls: [], time: 0, length: 0 }
    for (const name of ['playVideo', 'pauseVideo', 'setVolume', 'destroy']) p[name] = (...a) => p.calls.push([name, ...a])
    p.seekTo = t => { p.calls.push(['seekTo', t]); p.time = t }
    p.getCurrentTime = () => p.time
    p.getDuration = () => p.length
    yt.made = p
    return p
  }
  yt.fire = (event, data) => yt.made.opts.events[event]?.({ target: yt.made, data })
  return yt
}

const fakeBox = () => ({ style: {}, ownerDocument: { createElement: () => ({}) }, appendChild: x => x })

// A clip on a ready fake player, with every event it fires.
async function readyClip (opts = {}) {
  const yt = fakeYouTube()
  const clip = new YouTubeClip({ id: 'dQw4w9WgXcQ', box: fakeBox(), api: async () => yt, ...opts })
  const events = []
  for (const e of ['play', 'pause', 'timeupdate', 'ended', 'error']) clip.addEventListener(e, () => events.push(e))
  clip.mount()
  await new Promise(resolve => setImmediate(resolve))
  yt.fire('onReady')
  return { yt, clip, events, p: yt.made }
}

const settle = () => new Promise(resolve => setImmediate(resolve))

test('a YouTube clip makes its player in privacy-enhanced mode, without controls for attendees', async () => {
  const { p } = await readyClip()
  assert.equal(p.opts.videoId, 'dQw4w9WgXcQ')
  assert.equal(p.opts.host, 'https://www.youtube-nocookie.com')
  assert.equal(p.opts.playerVars.controls, 0)
  assert.equal(p.opts.playerVars.playsinline, 1)
  assert.equal(p.opts.playerVars.rel, 0)
})

test('a presenter gets YouTube controls', async () => {
  const yt = fakeYouTube()
  const clip = new YouTubeClip({ id: 'dQw4w9WgXcQ', box: fakeBox(), api: async () => yt })
  clip.controls = true
  clip.mount()
  clip.mount()
  await settle()
  assert.equal(yt.made.opts.playerVars.controls, 1)
})

test('nothing is loaded until the clip is first shown', async () => {
  let asked = 0
  const clip = new YouTubeClip({ id: 'dQw4w9WgXcQ', box: fakeBox(), api: async () => { asked += 1; return fakeYouTube() } })
  await settle()
  assert.equal(asked, 0)
  clip.mount()
  clip.mount()
  await settle()
  assert.equal(asked, 1)
})

test('play resolves once YouTube plays, and the clip is not paused from the call on', async () => {
  const { yt, clip, events, p } = await readyClip()
  assert.equal(clip.paused, true)
  let done = false
  const played = clip.play().then(() => { done = true })
  assert.equal(clip.paused, false)
  assert.deepEqual(p.calls.at(-1), ['playVideo'])
  yt.fire('onStateChange', S.BUFFERING)
  await settle()
  assert.equal(done, false)
  yt.fire('onStateChange', S.PLAYING)
  await played
  assert.deepEqual(events, ['play'], 'one play event, as a media element fires')
})

test('play rejects when the browser blocks autoplay, or the video cannot play', async () => {
  const blocked = await readyClip()
  const a = blocked.clip.play()
  blocked.yt.fire('onAutoplayBlocked')
  await assert.rejects(a)
  assert.equal(blocked.clip.paused, true)
  const broken = await readyClip()
  const b = broken.clip.play()
  broken.yt.fire('onError', 101)
  await assert.rejects(b)
  assert.ok(broken.events.includes('error'))
})

test('pause pauses, and YouTube confirming it fires nothing more', async () => {
  const { yt, clip, events, p } = await readyClip()
  clip.play()
  yt.fire('onStateChange', S.PLAYING)
  clip.pause()
  assert.equal(clip.paused, true)
  assert.deepEqual(p.calls.at(-1), ['pauseVideo'])
  yt.fire('onStateChange', S.PAUSED)
  await settle()
  assert.deepEqual(events, ['play', 'pause'])
})

test('a presenter pausing or playing in the YouTube player itself fires pause and play', async () => {
  const { yt, clip, events } = await readyClip()
  yt.fire('onStateChange', S.PLAYING)
  assert.equal(clip.paused, false)
  yt.fire('onStateChange', S.PAUSED)
  assert.equal(clip.paused, true)
  await settle()
  assert.deepEqual(events, ['play', 'pause'])
})

test('currentTime, duration and volume go to the player', async () => {
  const { yt, clip, p } = await readyClip()
  assert.ok(Number.isNaN(clip.duration), 'unknown until YouTube knows it')
  p.length = 212
  assert.equal(clip.duration, 212)
  yt.fire('onStateChange', S.PAUSED)
  clip.currentTime = 42
  assert.deepEqual(p.calls.at(-1), ['seekTo', 42])
  assert.equal(clip.currentTime, 42)
  clip.volume = 0.25
  assert.deepEqual(p.calls.at(-1), ['setVolume', 25])
})

test('what is asked before the player is ready is done once it is: the last seek wins', async () => {
  const yt = fakeYouTube()
  const clip = new YouTubeClip({ id: 'dQw4w9WgXcQ', box: fakeBox(), api: async () => yt })
  clip.volume = 0.5
  clip.currentTime = 10
  clip.currentTime = 20
  assert.equal(clip.currentTime, 20)
  clip.play()
  await settle()
  assert.deepEqual(yt.made.calls, [], 'nothing before ready')
  yt.fire('onReady')
  assert.deepEqual(yt.made.calls, [['setVolume', 50], ['seekTo', 20], ['playVideo']])
})

test('while playing, the clip reports its time; an end time in the link ends it there', async () => {
  const { yt, clip, events, p } = await readyClip({ endMs: 30000 })
  p.length = 212
  assert.equal(clip.duration, 30)
  clip.play()
  yt.fire('onStateChange', S.PLAYING)
  p.time = 12
  clip.tick()
  await settle()
  assert.equal(events.at(-1), 'timeupdate')
  p.time = 30.1
  clip.tick()
  assert.equal(clip.paused, true)
  assert.deepEqual(p.calls.at(-1), ['pauseVideo'])
  await settle()
  assert.deepEqual(events.slice(-2), ['pause', 'ended'])
  clip.destroy()
  assert.deepEqual(p.calls.at(-1), ['destroy'])
})

test('a looping clip starts over when it ends', async () => {
  const { yt, clip, events, p } = await readyClip()
  clip.loop = true
  clip.play()
  yt.fire('onStateChange', S.PLAYING)
  yt.fire('onStateChange', S.ENDED)
  assert.deepEqual(p.calls.slice(-2), [['seekTo', 0], ['playVideo']])
  assert.equal(clip.paused, false)
  await settle()
  assert.deepEqual(events, ['play'])
})

test('a clip whose YouTube API cannot load fires error', async () => {
  const clip = new YouTubeClip({ id: 'dQw4w9WgXcQ', box: fakeBox(), api: async () => { throw new Error('youtube-unavailable') } })
  let errors = 0
  clip.addEventListener('error', () => { errors += 1 })
  clip.mount()
  await settle()
  assert.equal(errors, 1)
  await assert.rejects(clip.play())
})

test('a paused clip that has not started is moved only when it plays: YouTube would play it', async () => {
  const { yt, clip, events, p } = await readyClip()
  const before = p.calls.length
  clip.currentTime = 0
  clip.currentTime = 12
  assert.equal(p.calls.length, before, 'YouTube plays an unstarted video it is asked to seek')
  assert.equal(clip.currentTime, 12)
  clip.play()
  assert.deepEqual(p.calls.slice(-2), [['seekTo', 12], ['playVideo']])
  yt.fire('onStateChange', S.PLAYING)
  yt.fire('onStateChange', S.PAUSED)
  clip.currentTime = 30
  assert.deepEqual(p.calls.at(-1), ['seekTo', 30], 'a started, paused video stays paused when moved')
  yt.fire('onStateChange', S.ENDED)
  const after = p.calls.length
  clip.currentTime = 0
  assert.equal(p.calls.length, after, 'nor is an ended one')
  await settle()
  assert.deepEqual(events.filter(e => e === 'play'), ['play'], 'no play but the one asked for')
})

test('a clip destroyed while YouTube loads makes no player, and a player ready after that is destroyed', async () => {
  const yt = fakeYouTube()
  let loaded
  const clip = new YouTubeClip({ id: 'dQw4w9WgXcQ', box: fakeBox(), api: () => new Promise(resolve => { loaded = resolve }) })
  clip.play()
  clip.destroy()
  loaded(yt)
  await settle()
  assert.equal(yt.made, null, 'no player for a destroyed clip')

  const late = await readyClipBeforeReady()
  late.clip.play()
  late.clip.destroy()
  late.yt.fire('onReady')
  assert.deepEqual(late.yt.made.calls, [['destroy']], 'nothing played, and the player is let go')
})

// A clip whose player is made but not yet ready.
async function readyClipBeforeReady () {
  const yt = fakeYouTube()
  const clip = new YouTubeClip({ id: 'dQw4w9WgXcQ', box: fakeBox(), api: async () => yt })
  clip.mount()
  await settle()
  return { yt, clip }
}

// A DeckcraftPlayer with only its media plumbing: no worker, no page.
function bareCanvasPlayer () {
  const p = Object.create(DeckcraftPlayer.prototype)
  p.handlers = {}
  p.errors = []
  p.on('error', e => p.errors.push(e.message))
  return p
}

test('a clip that cannot play is not reported as blocked sound', async () => {
  const p = bareCanvasPlayer()
  const unavailable = Object.assign(new Error('video-unavailable'), { name: 'NotSupportedError' })
  p.play({ el: { paused: true, play: () => Promise.reject(unavailable) }, quiet: 0 })
  await settle()
  assert.deepEqual(p.errors, [])
  p.play({ el: { paused: true, play: () => Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' })) }, quiet: 0 })
  await settle()
  assert.deepEqual(p.errors, ['sound-blocked'])
})
