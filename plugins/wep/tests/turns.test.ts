import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const BASE = 'https://wordexchangeplaza.com'

const ITEM = {
  itemId: 'p1',
  targetText: 'नमस्ते दोस्त',
  english: ['Hello friend'],
  transliterations: { itrans: 'namaste dost' },
  confusables: [
    { native: 'अलविदा दोस्त', resolvedEnglish: ['Goodbye friend'] },
    { native: 'धन्यवाद दोस्त', resolvedEnglish: ['Thank you friend'] },
    { native: 'माफ़ करना दोस्त', resolvedEnglish: ['Sorry friend'] },
  ],
}

const WORD = {
  itemId: 'w1',
  type: 'word',
  targetText: 'पानी',
  english: ['water'],
  transliterations: { itrans: 'pAnI' },
  audioKey: 'a1b2c3d4e5f60718',
  audioTrimStart: 0.25,
  audioTrimEnd: 1.75,
  confusables: [
    { native: 'चाय', resolvedEnglish: ['tea'] },
    { native: 'दूध', resolvedEnglish: ['milk'] },
    { native: 'खाना', resolvedEnglish: ['food'] },
  ],
}
const BLANKED = { ...ITEM, itemId: 'p2', targetText: 'मुझे पानी चाहिए', english: ['I need water'], blankWord: WORD }

type World = {
  clock: ReturnType<typeof mock.clock>
  opens: number
  closes: number
  toasts: string[]
  records: { path: string; isCorrect: boolean; reactionTimeMs: number | null; level?: number; blankWordItemId?: string }[]
  requests: string[]
  /** What was handed to ffplay, and to the engine's own player. */
  spawns: string[][]
  plays: unknown[]
}

// The world beneath the plugin: a linked, switched-on terminal (unless told
// otherwise), a server with one phrase, and a terminal wide enough for a pane.
function world(
  on: On,
  { isLinked = true, isOn = true, isPlaced = true, check = 'allow', settings = {}, hasExtinction = true, hasFfplay = true } = {},
): World {
  const state: World = { clock: mock.clock(on, { now: 1_000_000 }), opens: 0, closes: 0, toasts: [], records: [], requests: [], spawns: [], plays: [] }
  mock.store(on, { ...(isLinked ? { link: { token: 'link-token', baseUrl: BASE } } : {}), isOn })

  const json = (data: unknown, status = 200) => ({
    value: { status, ok: status >= 200 && status < 300, headers: {}, text: JSON.stringify(data) },
  })
  on('http.fetch', ($, e) => {
    const path = e.url.replace(BASE, '')
    state.requests.push(`${e.init?.method ?? 'GET'} ${path}`)
    if (path === '/api/me') {
      return json({ currentStreak: 4, settings: { gameMode: 'a', difficultyMode: 'hard', ...settings } })
    }
    if (path === '/api/gameplay/course') return json({ courseId: 'hi-en-v1', title: 'Hindi', transliterationTypes: ['itrans'] })
    if (path.startsWith('/api/gameplay/course/hi-en-v1/items')) {
      return json({ items: [path.endsWith('level=1') ? WORD : path.endsWith('level=2') ? BLANKED : ITEM] })
    }
    if (path.startsWith('/api/extinction/')) {
      if (!hasExtinction) return json({ error: 'This token cannot be used here' }, 403)
      if (path.startsWith('/api/extinction/items')) return json({ items: [WORD] })
    }
    if (path === '/api/gameplay/record' || path === '/api/extinction/record') {
      state.records.push({ path, ...JSON.parse(e.init?.body ?? '{}') })

      return json({ ok: true, currentStreak: 5, pointsAwarded: 10 })
    }
    if (path === '/api/claude-link/pair') return json({ code: 'ABCD2345', pollSecret: 'secret', expiresInSeconds: 600 })
    if (path === '/api/claude-link/poll') return json({ status: 'approved', token: 'new-token', name: 'Learner' })

    return json({ error: 'not found' }, 404)
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('process.run', ($, e) => ({
    value: {
      exitCode: e.argv.includes('ffplay') && !hasFfplay ? 127 : 0,
      stdout: '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('process.spawn', async function* ($, e) {
    state.spawns.push([...e.argv])

    return { code: 0, signal: null }
  })
  on('audio.play', ($, e) => {
    state.plays.push(e.clip)

    return { value: undefined }
  })
  on('ui.open', () => {
    state.opens += 1

    return { value: isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'narrow' } }
  })
  on('ui.close', () => {
    state.closes += 1

    return { value: undefined }
  })
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, null) as never)
  on('ui.toast', ($, e) => {
    state.toasts.push(e.text)

    return { value: undefined }
  })
  on('tool.check', () => ({ decision: check as 'allow' | 'ask' }))
  on('tool.call', () => ({ result: { text: 'ok' } }) as never)

  return state
}

const START = { cwd: '/work', surface: 'terminal' as const, isInteractive: true }
const turn = { text: 'do the thing', turnId: 't1' }
const done = { answer: 'Done.', durationMs: 5000, isAborted: false, turnId: 't1', reason: 'answer' as const }
const PANE_PROPS = {
  title: 'Word Exchange Plaza',
  isFocused: true,
  bodyColumns: 80,
  placement: 'inline',
} as never

const mountPane = ($: Parameters<Parameters<typeof test>[1]>[0]) =>
  $.ui.mount({ plugin: 'wep', surface: 'terminal', component: 'Pane', requestId: 'wep', props: PANE_PROPS })
type Pane = Awaited<ReturnType<typeof mountPane>>

const buttons = async (pane: Pane) => pane.findAll({ type: 'Button' })
const pressText = async (pane: Pane, text: string) => {
  const button = (await buttons(pane)).find(candidate => candidate.text?.includes(text))
  expect(button).toBeDefined()
  await pane.press({ key: String(button?.key) })
}

test('opens two seconds into the session, before any turn', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.clock.advance(1900)
  expect(w.opens).toBe(0)
  await w.clock.advance(200)
  expect(w.opens).toBe(1)
})

test('stays out when switched off or not linked', async ($, on) => {
  const w = world(on, { isOn: false })
  await $.session.start(START)
  await $.turn.start(turn)
  await w.clock.advance(5000)
  expect(w.opens).toBe(0)
  expect(w.requests).toEqual([])
})

test('opens on the menu, and loads nothing until a mode is picked', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.turn.start(turn)
  await w.clock.advance(2100)
  const pane = await mountPane($)
  const labels = (await buttons(pane)).map(button => button.text)
  expect(labels.length).toBe(4)
  expect(labels[0]).toContain('Level 1')
  expect(labels[3]).toContain('Extinction')
  expect(w.requests).toEqual([])
  await pressText(pane, 'Level 3')
  expect(w.requests).toContain('GET /api/gameplay/course/hi-en-v1/items?mode=a&level=3')
  await pane.unmount()
})

test('stays open when Claude finishes, is interrupted, asks permission or asks a question', async ($, on) => {
  const w = world(on, { check: 'ask' })
  await $.session.start(START)
  await $.turn.start(turn)
  await w.clock.advance(2100)
  await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 'tu1' })
  await $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'tu2', questions: [] } as never)
  await $.turn.complete(done)
  await w.clock.advance(10_000)
  await $.turn.start({ ...turn, turnId: 't2' })
  await $.turn.complete({ ...done, turnId: 't2', isAborted: true, reason: 'aborted' })
  await w.clock.advance(10_000)
  expect(w.opens).toBe(1)
  expect(w.closes).toBe(0)
})

test('keeps playing when a subagent finishes', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.turn.start(turn)
  await w.clock.advance(2100)
  await $.turn.complete({ ...done, agentId: 'agent-1' })
  await w.clock.advance(5000)
  expect(w.closes).toBe(0)
})

test('/wep hide closes it across turns until /wep brings it back', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.turn.start(turn)
  await w.clock.advance(2100)
  await $.command.run({ command: 'wep', args: 'hide' } as never)
  expect(w.closes).toBe(1)
  await $.turn.complete(done)
  await $.turn.start({ ...turn, turnId: 't2' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'tu1', command: 'ls' } as never)
  await w.clock.advance(5000)
  expect(w.opens).toBe(1)
  await $.command.run({ command: 'wep', args: '' } as never)
  expect(w.opens).toBe(2)
})

test('a narrow terminal gets an offer above the prompt instead of a pane', async ($, on) => {
  const w = world(on, { isPlaced: false })
  await $.session.start(START)
  await $.turn.start(turn)
  await w.clock.advance(2100)
  const band = await $.ui.mount({ plugin: 'wep', surface: 'terminal', component: 'AbovePrompt', props: {} as never })
  expect(await band.find({ key: 'play' })).toBeDefined()
  await band.unmount()
})

test('a right answer is recorded with the time it took, at level 3', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.turn.start(turn)
  await w.clock.advance(2000)
  const pane = await mountPane($)
  await pressText(pane, 'Level 3')
  await w.clock.advance(1500)
  await pressText(pane, 'Hello friend')
  expect(w.records.length).toBe(1)
  expect(w.records[0]?.isCorrect).toBe(true)
  expect(w.records[0]?.level).toBe(3)
  expect(w.records[0]?.reactionTimeMs).toBe(1500)
  await pane.unmount()
})

test('level 1 asks a word and records at level 1', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.turn.start(turn)
  await w.clock.advance(2000)
  const pane = await mountPane($)
  await pressText(pane, 'Level 1')
  await pressText(pane, 'water')
  expect(w.records[0]?.path).toBe('/api/gameplay/record')
  expect(w.records[0]?.level).toBe(1)
  await pane.unmount()
})

test('level 2 fills the blank and names the blank word in the record', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.turn.start(turn)
  await w.clock.advance(2000)
  const pane = await mountPane($)
  await pressText(pane, 'Level 2')
  await pressText(pane, 'water')
  expect(w.records[0]?.level).toBe(2)
  expect(w.records[0]?.blankWordItemId).toBe('w1')
  await pane.unmount()
})

test('extinction records to its own route, and asks each word once', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.turn.start(turn)
  await w.clock.advance(2000)
  const pane = await mountPane($)
  await pressText(pane, 'Extinction')
  await pressText(pane, 'water')
  expect(w.records[0]?.path).toBe('/api/extinction/record')
  expect(w.records[0]?.level).toBeUndefined()
  await w.clock.advance(1300)
  expect((await buttons(pane)).map(button => button.text)).toEqual(['Menu'])
  await pane.unmount()
})

test('a server without the extinction routes says so and keeps the link', async ($, on) => {
  const w = world(on, { hasExtinction: false })
  await $.session.start(START)
  await $.turn.start(turn)
  await w.clock.advance(2000)
  const pane = await mountPane($)
  await pressText(pane, 'Extinction')
  await pressText(pane, 'Menu')
  await pressText(pane, 'Level 3')
  await pressText(pane, 'Hello friend')
  expect(w.records.length).toBe(1)
  await pane.unmount()
})

test('the menu button changes mode mid-game', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.turn.start(turn)
  await w.clock.advance(2000)
  const pane = await mountPane($)
  await pressText(pane, 'Level 3')
  await pressText(pane, 'Menu')
  await pressText(pane, 'Level 1')
  await pressText(pane, 'water')
  expect(w.records[0]?.level).toBe(1)
  await pane.unmount()
})

test('time spent hidden is not counted against the answer', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.clock.advance(2000)
  const first = await mountPane($)
  await pressText(first, 'Level 3')
  await first.unmount()
  await w.clock.advance(1000)
  await $.command.run({ command: 'wep', args: 'hide' } as never)
  await w.clock.advance(60_000)
  await $.command.run({ command: 'wep', args: '' } as never)
  const pane = await mountPane($)
  await w.clock.advance(500)
  await pressText(pane, 'Hello friend')
  expect(w.records[0]?.reactionTimeMs).toBe(1500)
  await pane.unmount()
})

test('running out of time is not counted or recorded, and waits for Next', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.turn.start(turn)
  await w.clock.advance(2000)
  const pane = await mountPane($)
  await pressText(pane, 'Level 3')
  await w.clock.advance(10_100)
  expect(w.records.length).toBe(0)
  expect((await buttons(pane)).some(button => button.text?.includes('Hello friend'))).toBe(false)
  await w.clock.advance(60_000)
  expect((await buttons(pane)).some(button => button.text?.includes('Hello friend'))).toBe(false)
  await pressText(pane, 'Next')
  await pressText(pane, 'Hello friend')
  expect(w.records.length).toBe(1)
  expect(w.records[0]?.isCorrect).toBe(true)
  await pane.unmount()
})

test('a wrong press is still recorded as a miss', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.turn.start(turn)
  await w.clock.advance(2000)
  const pane = await mountPane($)
  await pressText(pane, 'Level 3')
  await pressText(pane, 'Goodbye friend')
  expect(w.records[0]?.isCorrect).toBe(false)
  await pane.unmount()
})

test('long haul waits for the answer, then counts down to the next round', async ($, on) => {
  const w = world(on, { settings: { longHaulMode: true, longHaulCooldownSeconds: 30 } })
  await $.session.start(START)
  await $.turn.start(turn)
  await w.clock.advance(2000)
  const pane = await mountPane($)
  await pressText(pane, 'Level 3')
  await w.clock.advance(15_000)
  await pressText(pane, 'Hello friend')
  expect(w.records[0]?.reactionTimeMs).toBe(15_000)
  await w.clock.advance(29_000)
  expect((await buttons(pane)).some(button => button.text?.includes('Hello friend'))).toBe(false)
  await w.clock.advance(1500)
  expect((await buttons(pane)).some(button => button.text?.includes('Hello friend'))).toBe(true)
  await pane.unmount()
})

test('long haul: Next skips the countdown, and a very late answer is recorded without its time', async ($, on) => {
  const w = world(on, { settings: { longHaulMode: true } })
  await $.session.start(START)
  await $.turn.start(turn)
  await w.clock.advance(2000)
  const pane = await mountPane($)
  await pressText(pane, 'Level 3')
  await w.clock.advance(25_000)
  await pressText(pane, 'Hello friend')
  expect(w.records[0]?.isCorrect).toBe(true)
  expect(w.records[0]?.reactionTimeMs).toBeNull()
  await w.clock.advance(1000)
  await pressText(pane, 'Next')
  expect((await buttons(pane)).some(button => button.text?.includes('Hello friend'))).toBe(true)
  await pane.unmount()
})

test('/wep on an unlinked terminal starts pairing and links once approved', async ($, on) => {
  const w = world(on, { isLinked: false, isOn: false })
  await $.session.start(START)
  const ran = await $.command.run({ command: 'wep', args: '' } as never)
  expect(ran.text).toContain(`${BASE}/dashboard/claude-link?code=ABCD2345`)
  await w.clock.advance(2100)
  expect(w.toasts.some(text => text.startsWith('Linked as Learner'))).toBe(true)
  await $.turn.start(turn)
  await w.clock.advance(2100)
  expect(w.opens).toBe(1)
})

test('/wep off closes the pane and stays out', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.turn.start(turn)
  await w.clock.advance(2100)
  await $.command.run({ command: 'wep', args: 'off' } as never)
  expect(w.closes).toBe(1)
  await $.turn.complete(done)
  await $.turn.start({ ...turn, turnId: 't2' })
  await w.clock.advance(5000)
  expect(w.opens).toBe(1)
})

const WORD_CLIP = `${BASE}/api/gameplay/audio/a1b2c3d4e5f60718?token=link-token&trim=1`

test('a word asked in its own script is spoken once as it appears, and again on Replay', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.clock.advance(2000)
  const pane = await mountPane($)
  await pressText(pane, 'Level 1')
  expect(w.spawns).toEqual([['env', 'PULSE_LATENCY_MSEC=1000', 'ffplay', '-nodisp', '-loglevel', 'quiet', WORD_CLIP]])
  await w.clock.advance(3500)
  expect(w.spawns.length).toBe(1)
  await pressText(pane, 'Replay')
  expect(w.spawns.length).toBe(2)
  await pressText(pane, 'water')
  expect(w.spawns.length).toBe(2)
  await pane.unmount()
})

test('long haul speaks the word again every three seconds until it is answered', async ($, on) => {
  const w = world(on, { settings: { longHaulMode: true } })
  await $.session.start(START)
  await w.clock.advance(2000)
  const pane = await mountPane($)
  await pressText(pane, 'Level 1')
  expect(w.spawns.length).toBe(1)
  await w.clock.advance(2900)
  expect(w.spawns.length).toBe(1)
  await w.clock.advance(200)
  expect(w.spawns.length).toBe(2)
  await w.clock.advance(3000)
  expect(w.spawns.length).toBe(3)
  await pressText(pane, 'water')
  await w.clock.advance(9000)
  expect(w.spawns.length).toBe(3)
  await pane.unmount()
})

test('long haul goes quiet past the time limit when the account asks for that', async ($, on) => {
  const w = world(on, { settings: { longHaulMode: true, longHaulStopRepeatAtExpiry: true } })
  await $.session.start(START)
  await w.clock.advance(2000)
  const pane = await mountPane($)
  await pressText(pane, 'Level 1')
  await w.clock.advance(6500)
  expect(w.spawns.length).toBe(3)
  await w.clock.advance(20000)
  expect(w.spawns.length).toBe(3)
  await pane.unmount()
})

test('a word asked in English is spoken only once it is answered', async ($, on) => {
  const w = world(on, { settings: { gameMode: 'b' } })
  await $.session.start(START)
  await w.clock.advance(2000)
  const pane = await mountPane($)
  await pressText(pane, 'Level 1')
  expect(w.spawns).toEqual([])
  expect((await buttons(pane)).some(button => button.text?.includes('Replay'))).toBe(false)
  await pressText(pane, 'पानी')
  expect(w.spawns.length).toBe(1)
  expect((await buttons(pane)).some(button => button.text?.includes('Replay'))).toBe(true)
  await pane.unmount()
})

test('an item with no recording is silent', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.clock.advance(2000)
  const pane = await mountPane($)
  await pressText(pane, 'Level 3')
  expect(w.spawns).toEqual([])
  expect((await buttons(pane)).some(button => button.text?.includes('Replay'))).toBe(false)
  await pane.unmount()
})

test('/wep sound off keeps it quiet, and /wep sound brings it back', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.clock.advance(2000)
  await $.command.run({ command: 'wep', args: 'sound off' } as never)
  const pane = await mountPane($)
  await pressText(pane, 'Level 1')
  expect(w.spawns).toEqual([])
  expect((await buttons(pane)).some(button => button.text?.includes('Replay'))).toBe(false)
  const ran = await $.command.run({ command: 'wep', args: 'sound' } as never)
  expect(ran.text).toContain('sound is on')
  await pressText(pane, 'Replay')
  expect(w.spawns.length).toBe(1)
  await pane.unmount()
})

test('without ffplay the clip goes to the engine\'s own player', async ($, on) => {
  const w = world(on, { hasFfplay: false })
  await $.session.start(START)
  await w.clock.advance(2000)
  const pane = await mountPane($)
  await pressText(pane, 'Level 1')
  expect(w.spawns).toEqual([])
  expect(w.plays).toEqual([{ url: WORD_CLIP }])
  await pane.unmount()
})
