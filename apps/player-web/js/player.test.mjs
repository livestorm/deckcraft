// The page side's trim and loop rule, run with `node --test apps/player-web/js/player.test.mjs`.
import test from 'node:test'
import assert from 'node:assert/strict'

import { DeckcraftPlayer, LinkRequests, NotesRequest, YouTubeClip, insideQuad, linkDestination, linkLabel, loadYouTubeApi, safeLinkUrl, trimStep, youtubeVideo } from './player.js'

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
  for (const e of ['play', 'pause', 'timeupdate', 'ended', 'error', 'seeked']) clip.addEventListener(e, () => events.push(e))
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

test('opening media again lets go of the clips it replaces', () => {
  const p = bareCanvasPlayer()
  p.layer = { replaceChildren () {} }
  let destroyed = 0
  p.media = [{ el: { src: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', destroy: () => { destroyed += 1 } } }]
  p.buildMedia([])
  assert.equal(destroyed, 1)
  assert.deepEqual(p.media, [])
})

// A clip on a ready fake player whose clock the test moves, in ms.
async function clockedClip () {
  const clock = { ms: 0 }
  const ready = await readyClip({ now: () => clock.ms })
  return { ...ready, clock }
}

test('a seek in YouTube\'s own controls fires seeked, while playing or paused', async () => {
  const { yt, clip, events, p, clock } = await clockedClip()
  const at = (ms, time) => { clock.ms = ms; p.time = time; clip.tick() }
  clip.play()
  yt.fire('onStateChange', S.PLAYING)
  at(0, 10)
  at(250, 10.25)
  yt.fire('onStateChange', S.BUFFERING)
  at(2250, 10.25) // buffering: the time stands still
  yt.fire('onStateChange', S.PLAYING)
  at(2500, 10.5)
  await settle()
  assert.equal(events.includes('seeked'), false)
  at(2750, 40)
  await settle()
  assert.equal(events.filter(e => e === 'seeked').length, 1)
  clip.pause()
  yt.fire('onStateChange', S.PAUSED)
  at(3000, 40)
  at(5000, 40)
  at(5250, 5)
  await settle()
  assert.equal(events.filter(e => e === 'seeked').length, 2)
  clip.destroy()
})

test('the clip\'s own seeks and loops fire no seeked', async () => {
  const { yt, clip, events, p, clock } = await clockedClip()
  const at = (ms, time) => { clock.ms = ms; p.time = time; clip.tick() }
  clip.loop = true
  clip.play()
  yt.fire('onStateChange', S.PLAYING)
  at(0, 10)
  clip.currentTime = 80
  at(250, 80)
  at(500, 80.25)
  yt.fire('onStateChange', S.ENDED) // the loop seeks to 0 and plays
  yt.fire('onStateChange', S.PLAYING)
  at(750, 0)
  await settle()
  assert.equal(events.includes('seeked'), false)
  clip.destroy()
})

// A media element as the player sees it, with the events it fires.
class FakeMedia extends EventTarget {
  constructor () {
    super()
    this.paused = true
    this.currentTime = 0
    this.loop = false
    this.duration = 60
    this.playbackRate = 1
  }

  play () { this.paused = false; return Promise.resolve() }
  pause () { this.paused = true }
  fire (type) { this.dispatchEvent(new Event(type)) }
}

// A presenter's player with one clip on the slide shown, and the media actions it sends.
function presenterWithClip () {
  const p = bareCanvasPlayer()
  p.controls = true
  p.position = [0, 0]
  p.clock = () => 1000
  const clip = { shape: 7, slide: 0, el: new FakeMedia(), quiet: 0 }
  p.media = [clip]
  p.report(clip)
  const sent = []
  p.on('mediaAction', a => sent.push(a))
  return { p, clip, el: clip.el, sent }
}

test('a presenter\'s seek is sent with where the clip is and whether it plays', () => {
  const { el, sent } = presenterWithClip()
  el.paused = false
  el.currentTime = 42
  el.fire('seeked')
  el.paused = true
  el.currentTime = 3
  el.fire('seeked')
  assert.deepEqual(sent, [{ shape: 7, action: 'play', at: 42, time: 1000 }, { shape: 7, action: 'pause', at: 3, time: 1000 }])
})

test('the player\'s own seeks are not sent: media actions, cues, and a video starting over', () => {
  const { p, el, sent } = presenterWithClip()
  el.currentTime = 10
  p.mediaAction({ shape: 7, action: 'pause', at: 42 })
  assert.equal(el.currentTime, 42)
  el.fire('seeked')
  p.cue(7, 'play')
  el.fire('seeked')
  p.stopMedia()
  el.fire('seeked')
  el.loop = true
  el.currentTime = 0.1
  el.fire('seeked')
  assert.deepEqual(sent, [])
  el.loop = false
  el.paused = false
  el.currentTime = 60
  el.fire('seeked')
  assert.deepEqual(sent, [{ shape: 7, action: 'play', at: 60, time: 1000 }])
})

test('a presenter\'s play and pause carry the time on the shared clock', () => {
  const { el, sent } = presenterWithClip()
  el.currentTime = 4
  el.fire('play')
  assert.deepEqual(sent, [{ shape: 7, action: 'play', at: 4, time: 1000 }])
})

// A viewer's player with one clip on the slide shown, and a shared clock the test sets, in ms.
function viewerWithClip (clip = {}) {
  const p = bareCanvasPlayer()
  p.position = [0, 0]
  const clock = { ms: 0 }
  p.clock = () => clock.ms
  const m = { shape: 7, slide: 0, el: new FakeMedia(), quiet: 0, ...clip }
  p.media = [m]
  return { p, m, el: m.el, clock }
}

test('a play that arrives late, or is handed to someone joining, starts where everyone else is', () => {
  const { p, el, clock } = viewerWithClip()
  clock.ms = 10000
  p.mediaAction({ shape: 7, action: 'play', at: 20, time: 7000 })
  assert.equal(el.currentTime, 23)
  assert.equal(el.paused, false)
  p.mediaAction({ shape: 7, action: 'pause', at: 30, time: 2000 })
  assert.equal(el.currentTime, 30)
  assert.equal(el.paused, true)
})

test('a media action without a time does what it always did, and is not corrected', () => {
  const { p, m, el, clock } = viewerWithClip()
  clock.ms = 10000
  p.mediaAction({ shape: 7, action: 'play', at: 20 })
  assert.equal(el.currentTime, 20)
  clock.ms = 50000
  p.sync()
  assert.equal(el.currentTime, 20)
  assert.equal(m.anchor, null)
})

test('a video a little off plays slightly faster or slower; one far off jumps, then is left to settle', () => {
  const { p, el, clock } = viewerWithClip()
  p.mediaAction({ shape: 7, action: 'play', at: 0, time: 0 })
  clock.ms = 10000
  el.currentTime = 10.05
  p.sync()
  assert.equal(el.playbackRate, 1)
  el.currentTime = 10.3
  p.sync()
  assert.equal(el.playbackRate, 0.95)
  el.currentTime = 9.7
  p.sync()
  assert.equal(el.playbackRate, 1.05)
  el.currentTime = 12
  p.sync()
  assert.equal(el.currentTime, 10)
  assert.equal(el.playbackRate, 1)
  clock.ms = 12000
  el.currentTime = 9 // still loading after the jump
  p.sync()
  assert.equal(el.currentTime, 9)
  clock.ms = 14000
  p.sync()
  assert.equal(el.currentTime, 14)
})

test('YouTube, whose speed cannot be nudged, jumps only when more than a second off', () => {
  const { p, el, clock } = viewerWithClip()
  delete el.playbackRate
  p.mediaAction({ shape: 7, action: 'play', at: 0, time: 0 })
  clock.ms = 10000
  el.currentTime = 10.8
  p.sync()
  assert.equal(el.currentTime, 10.8)
  assert.equal('playbackRate' in el, false)
  el.currentTime = 11.5
  p.sync()
  assert.equal(el.currentTime, 10)
})

test('a looping clip is followed round its loop, or its trim range', () => {
  const { p, el, clock } = viewerWithClip({ loop: true })
  el.loop = true
  clock.ms = 30000
  p.mediaAction({ shape: 7, action: 'play', at: 50, time: 0 })
  assert.equal(el.currentTime, 20)
  clock.ms = 70200
  el.currentTime = 59.9 // about to start over: 0.3 s behind, not 59.7 ahead
  p.sync()
  assert.equal(el.currentTime, 59.9)
  assert.equal(el.playbackRate, 1.05)

  const trimmed = viewerWithClip({ loop: true, trimStartMs: 10000, trimEndMs: 10000 })
  trimmed.clock.ms = 10000
  trimmed.p.mediaAction({ shape: 7, action: 'play', at: 45, time: 0 })
  assert.equal(trimmed.el.currentTime, 15)
})

test('a clip that would have ended by now is not started again', () => {
  const { p, el, clock } = viewerWithClip()
  el.currentTime = 50
  clock.ms = 20000
  p.mediaAction({ shape: 7, action: 'play', at: 50, time: 0 })
  assert.equal(el.paused, true)
  assert.equal(el.currentTime, 50)
})

test('paused clips are not corrected, and leaving the slide forgets the anchor', () => {
  const { p, m, el, clock } = viewerWithClip()
  p.mediaAction({ shape: 7, action: 'play', at: 0, time: 0 })
  el.pause()
  clock.ms = 10000
  p.sync()
  assert.equal(el.currentTime, 0)
  p.stopMedia()
  assert.equal(m.anchor, null)
})

test('a cue anchors the clip where it starts, on this viewer\'s clock', () => {
  const { p, el, clock } = viewerWithClip()
  clock.ms = 5000
  p.cue(7, 'play')
  clock.ms = 10000
  el.currentTime = 3
  p.sync()
  assert.equal(el.currentTime, 5)
})

// Links.

test('only web, mail and phone links may be opened', () => {
  for (const ok of ['https://example.com/a?b=c#d', 'http://example.com', ' https://example.com ', 'mailto:team@example.com', 'tel:+33123456789']) {
    assert.equal(safeLinkUrl(ok), ok.trim(), ok)
  }
  for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', ' javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'slide3.xml',
    '../x', '//example.com', 'https://', 'https:///x', 'https:example.com', 'https://exa mple.com', 'https://example.com/\u0000', 'mailto:', 'tel:',
    'tel:<b>', 'vbscript:x', 'blob:https://example.com/1', 'ms-word:ofe|u|https://x', '', null, undefined, 42, `https://example.com/${'a'.repeat(2048)}`]) {
    assert.equal(safeLinkUrl(bad), null, String(bad))
  }
})

test('a point is inside a turned box only inside its outline', () => {
  const diamond = [[0.5, 0.1], [0.7, 0.3], [0.5, 0.5], [0.3, 0.3]]
  assert.equal(insideQuad(diamond, 0.5, 0.3), true)
  assert.equal(insideQuad(diamond, 0.5, 0.1), true, 'a corner')
  assert.equal(insideQuad(diamond, 0.32, 0.12), false, 'inside its bounding box only')
  assert.equal(insideQuad([[0, 0], [1, 0], [1, 0], [0, 0]], 0.5, 0), false, 'no area')
  assert.equal(insideQuad(null, 0, 0), false)
})

const SLIDES = [
  { index: 0, steps: 0, autoFirst: false, title: 'Intro', fileId: 256 },
  { index: 1, steps: 2, autoFirst: true, title: 'Plan', fileId: 257 },
  { index: 3, steps: 1, autoFirst: false, title: '', fileId: 259 },
]

test('slide targets go where a click would enter the slide; Previous to the slide before, built', () => {
  assert.deepEqual(linkDestination({ type: 'slide', index: 1, fileId: 257 }, SLIDES, [0, 0]), [1, 1])
  assert.deepEqual(linkDestination({ type: 'slide', index: 2, fileId: 258 }, SLIDES, [0, 0]), null, 'not in the show')
  assert.deepEqual(linkDestination({ type: 'nextSlide' }, SLIDES, [1, 1]), [3, 0])
  assert.deepEqual(linkDestination({ type: 'nextSlide' }, SLIDES, [3, 0]), null, 'the last slide')
  assert.deepEqual(linkDestination({ type: 'previousSlide' }, SLIDES, [3, 0]), [1, 2])
  assert.deepEqual(linkDestination({ type: 'previousSlide' }, SLIDES, [0, 0]), null)
  assert.deepEqual(linkDestination({ type: 'firstSlide' }, SLIDES, [3, 0]), [0, 0])
  assert.deepEqual(linkDestination({ type: 'lastSlide' }, SLIDES, [0, 0]), [3, 0])
  assert.deepEqual(linkDestination({ type: 'endShow' }, SLIDES, [0, 0]), null)
  assert.deepEqual(linkDestination({ type: 'url', url: 'https://example.com' }, SLIDES, [0, 0]), null)
})

test('a link is labelled by its text, else its ScreenTip, with where it goes', () => {
  const url = { type: 'url', url: 'https://example.com' }
  assert.equal(linkLabel({ target: url, label: 'Our site' }), 'Our site (https://example.com)')
  assert.equal(linkLabel({ target: url, label: '', tooltip: 'Opens the site' }), 'Opens the site (https://example.com)')
  assert.equal(linkLabel({ target: { type: 'url', url: 'mailto:a@b.c' }, label: '' }), 'a@b.c')
  assert.equal(linkLabel({ target: { type: 'slide', index: 1 }, label: '' }, SLIDES), 'Slide 2: Plan')
  assert.equal(linkLabel({ target: { type: 'slide', index: 3 }, label: 'Details' }, SLIDES), 'Details (Slide 3)')
  assert.equal(linkLabel({ target: { type: 'nextSlide' }, label: '' }), 'Next slide')
})

// An element and a document as the player's link layer uses them.
class FakeElement {
  constructor (tag) {
    this.tag = tag
    this.style = {}
    this.attrs = {}
    this.children = []
    this.listeners = {}
  }

  setAttribute (k, v) { this.attrs[k] = v }
  addEventListener (type, fn) { (this.listeners[type] ||= []).push(fn) }
  replaceChildren (...children) { this.children = children }
  click () {
    const e = clickEvent(0, 0)
    for (const fn of this.listeners.click || []) fn(e)
    return e
  }
}

function clickEvent (clientX, clientY) {
  return {
    clientX,
    clientY,
    defaultPrevented: false,
    stopped: false,
    preventDefault () { this.defaultPrevented = true },
    stopPropagation () { this.stopped = true },
    stopImmediatePropagation () { this.stopped = true },
  }
}

const box = (x, y, w, h) => ({ rect: [x, y, w, h], quad: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] })
const WEB = { ...box(0.1, 0.1, 0.2, 0.1), target: { type: 'url', url: 'https://example.com/docs' }, shape: 4, text: true, label: 'the docs', tooltip: 'Read them' }
const NEXT = { ...box(0.6, 0.6, 0.2, 0.2), target: { type: 'nextSlide' }, shape: 5, text: false, label: '', tooltip: '' }
const JUMP = { ...box(0.6, 0.1, 0.2, 0.2), target: { type: 'slide', index: 3, fileId: 259 }, shape: 6, text: false, label: '', tooltip: '' }

// A player on slide 0 of SLIDES with `links`, on a 1000 × 500 px canvas. Hit tests go to a worker
// the test answers with `reply`; opened URLs and moves are recorded.
function linkPlayer ({ controls = false, links = [WEB, NEXT, JUMP] } = {}) {
  const p = bareCanvasPlayer()
  p.controls = controls
  p.info = { slides: SLIDES }
  p.position = [0, 0]
  p.canvas = { style: {}, title: '', getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 500 }) }
  p.linkLayer = new FakeElement('div')
  p.linkLayer.ownerDocument = { createElement: tag => new FakeElement(tag) }
  p.linkRequests = new LinkRequests()
  p.linkHoverMs = 100
  p.hover = { pointer: null, known: null, busy: false, again: false }
  p.worker = fakeWorker()
  p.openedUrls = []
  p.openLink = url => p.openedUrls.push(url)
  p.moves = []
  p.advance = pos => p.moves.push(pos)
  p.events = []
  p.on('link', e => p.events.push(e))
  p.showLinks(links)
  return p
}

// The worker's answer to the last hit test sent.
function reply (p, link) {
  const asked = p.worker.sent.filter(m => m.type === 'linkAt').at(-1)
  p.linkRequests.settle({ type: 'linkAt', id: asked.id, link })
  return asked
}

test('a click on a link emits link, opens it in a new tab, and is not the page\'s click', async () => {
  const p = linkPlayer()
  const e = clickEvent(150, 75)
  p.clicked(e)
  assert.equal(e.defaultPrevented, true)
  assert.equal(e.stopped, true)
  const asked = reply(p, WEB)
  assert.deepEqual([asked.x, asked.y], [0.15, 0.15])
  await settle()
  assert.equal(p.events.length, 1)
  const [ev] = p.events
  assert.deepEqual(ev.target, { type: 'url', url: 'https://example.com/docs' })
  assert.equal(ev.position, null)
  assert.equal(ev.moves, false)
  assert.equal(ev.label, 'the docs')
  assert.deepEqual(p.openedUrls, ['https://example.com/docs'])
  assert.deepEqual(p.moves, [], 'the slide does not advance')
})

test('a page that handles the link event opens nothing itself', async () => {
  const p = linkPlayer()
  p.on('link', e => e.preventDefault())
  p.clicked(clickEvent(150, 75))
  reply(p, WEB)
  await settle()
  assert.equal(p.events.length, 1)
  assert.deepEqual(p.openedUrls, [])
})

test('a click off every link is the page\'s: no hit test, nothing stopped', () => {
  const p = linkPlayer()
  const e = clickEvent(500, 25)
  p.clicked(e)
  assert.equal(e.defaultPrevented, false)
  assert.equal(e.stopped, false)
  assert.equal(p.worker.sent.length, 0)
})

test('a click where the hover found no link (another shape covers it) is the page\'s', async () => {
  const p = linkPlayer()
  p.pointerMoved({ clientX: 150, clientY: 75 })
  reply(p, null)
  await settle()
  const e = clickEvent(150, 75)
  p.clicked(e)
  assert.equal(e.stopped, false)
  assert.equal(p.events.length, 0)
})

test('after a hover, a click on the same spot follows the link at once', async () => {
  const p = linkPlayer()
  p.pointerMoved({ clientX: 150, clientY: 75 })
  reply(p, WEB)
  await settle()
  p.clicked(clickEvent(150, 75))
  assert.deepEqual(p.openedUrls, ['https://example.com/docs'], 'no wait for the worker')
  assert.equal(p.worker.sent.length, 1)
})

test('slide jumps move a presenter\'s deck; others get the event and stay', async () => {
  for (const controls of [false, true]) {
    const p = linkPlayer({ controls })
    p.clicked(clickEvent(700, 350))
    reply(p, NEXT)
    p.clicked(clickEvent(700, 100))
    reply(p, JUMP)
    await settle()
    assert.deepEqual(p.events.map(e => [e.target.type, e.position, e.moves]), [['nextSlide', [1, 1], controls], ['slide', [3, 0], controls]])
    assert.deepEqual(p.moves, controls ? [[1, 1], [3, 0]] : [])
    assert.deepEqual(p.openedUrls, [])
  }
})

test('a presenter whose page handles the event is not moved', async () => {
  const p = linkPlayer({ controls: true })
  p.on('link', e => e.preventDefault())
  p.clicked(clickEvent(700, 350))
  reply(p, NEXT)
  await settle()
  assert.deepEqual(p.moves, [])
})

test('a URL the page may not open is neither opened nor reported, whatever the worker says', async () => {
  const p = linkPlayer()
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd']) {
    p.clicked(clickEvent(150, 75))
    reply(p, { ...WEB, target: { type: 'url', url } })
  }
  await settle()
  assert.deepEqual(p.events, [])
  assert.deepEqual(p.openedUrls, [])
})

test('the pointer is a hand over a link that does something here, and hit tests are throttled', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const p = linkPlayer()
  for (let i = 0; i < 10; i++) p.pointerMoved({ clientX: 120 + i, clientY: 75 })
  assert.equal(p.worker.sent.length, 1, 'one hit test while one is out')
  reply(p, WEB)
  await settle()
  assert.equal(p.canvas.style.cursor, 'pointer')
  assert.equal(p.canvas.title, 'Read them')
  assert.equal(p.worker.sent.length, 1, 'the next waits for the interval')
  t.mock.timers.tick(100)
  assert.equal(p.worker.sent.length, 2, 'then the latest position is asked')
  assert.equal(p.worker.sent[1].x, 0.129)
  reply(p, WEB)
  await settle()
  t.mock.timers.tick(100)
  assert.equal(p.worker.sent.length, 2, 'nothing more without a move')
  // Off every link's box: the cursor goes back at once, without asking.
  p.pointerMoved({ clientX: 500, clientY: 25 })
  assert.equal(p.canvas.style.cursor, '')
  assert.equal(p.worker.sent.length, 2)
  // A slide target does nothing for an attendee: no hand.
  p.pointerMoved({ clientX: 700, clientY: 350 })
  reply(p, NEXT)
  await settle()
  assert.equal(p.canvas.style.cursor, '')
})

test('each link that does something here gets a labelled anchor that keyboards reach', () => {
  const attendee = linkPlayer()
  const [a] = attendee.linkLayer.children
  assert.equal(attendee.linkLayer.children.length, 1, 'slide targets only for presenters')
  assert.equal(a.tag, 'a')
  assert.equal(a.href, 'https://example.com/docs')
  assert.equal(a.target, '_blank')
  assert.equal(a.rel, 'noopener noreferrer')
  assert.equal(a.attrs['aria-label'], 'the docs (https://example.com/docs)')
  assert.match(a.style.cssText, /left:10%;top:10%;width:20%;height:10%/)
  assert.match(a.style.cssText, /pointer-events:none/, 'the mouse goes to the canvas')
  const e = a.click() // Enter on a focused anchor
  assert.equal(e.defaultPrevented, true)
  assert.deepEqual(attendee.openedUrls, ['https://example.com/docs'])
  const presenter = linkPlayer({ controls: true })
  assert.deepEqual(presenter.linkLayer.children.map(c => [c.href, c.attrs['aria-label']]), [
    ['https://example.com/docs', 'the docs (https://example.com/docs)'],
    ['#', 'Next slide'],
    ['#', 'Slide 3'],
  ])
  presenter.linkLayer.children[1].click()
  assert.deepEqual(presenter.moves, [[1, 1]])
})

test('a new position\'s links replace the old ones, and what the hover knew', () => {
  const p = linkPlayer()
  p.hover.known = { at: [0.15, 0.15], link: WEB }
  p.showLinks([])
  assert.deepEqual(p.links, [])
  assert.equal(p.linkLayer.children.length, 0)
  assert.equal(p.hover.known, null)
  const e = clickEvent(150, 75)
  p.clicked(e)
  assert.equal(e.stopped, false, 'no link here any more')
})

test('a link over several lines is one stop for keyboards and screen readers', () => {
  const line = (y) => ({ ...WEB, ...box(0.1, y, 0.2, 0.05) })
  const p = linkPlayer({ links: [line(0.1), line(0.15), line(0.2)] })
  const [first, ...rest] = p.linkLayer.children
  assert.equal(p.linkLayer.children.length, 3, 'each line still has its box')
  assert.equal(first.tabIndex, undefined)
  assert.equal(first.attrs['aria-hidden'], undefined)
  assert.deepEqual(rest.map(a => [a.tabIndex, a.attrs['aria-hidden']]), [[-1, 'true'], [-1, 'true']])
})
