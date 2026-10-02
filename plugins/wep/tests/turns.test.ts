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

type World = {
  clock: ReturnType<typeof mock.clock>
  opens: number
  closes: number
  toasts: string[]
  records: { isCorrect: boolean; reactionTimeMs: number; level: number }[]
  requests: string[]
}

// The world beneath the plugin: a linked, switched-on terminal (unless told
// otherwise), a server with one phrase, and a terminal wide enough for a pane.
function world(on: On, { isLinked = true, isOn = true, isPlaced = true, check = 'allow' } = {}): World {
  const state: World = { clock: mock.clock(on, { now: 1_000_000 }), opens: 0, closes: 0, toasts: [], records: [], requests: [] }
  mock.store(on, { ...(isLinked ? { link: { token: 'link-token', baseUrl: BASE } } : {}), isOn })

  const json = (data: unknown, status = 200) => ({
    value: { status, ok: status >= 200 && status < 300, headers: {}, text: JSON.stringify(data) },
  })
  on('http.fetch', ($, e) => {
    const path = e.url.replace(BASE, '')
    state.requests.push(`${e.init?.method ?? 'GET'} ${path}`)
    if (path === '/api/me') return json({ currentStreak: 4, settings: { gameMode: 'a', difficultyMode: 'hard' } })
    if (path === '/api/gameplay/course') return json({ courseId: 'hi-en-v1', title: 'Hindi', transliterationTypes: ['itrans'] })
    if (path.startsWith('/api/gameplay/course/hi-en-v1/items')) return json({ items: [ITEM] })
    if (path === '/api/gameplay/record') {
      state.records.push(JSON.parse(e.init?.body ?? '{}'))

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
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
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

test('drops in two seconds after a turn starts, not before', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.turn.start(turn)
  await w.clock.advance(1900)
  expect(w.opens).toBe(0)
  await w.clock.advance(200)
  expect(w.opens).toBe(1)
  expect(w.requests).toContain('GET /api/me')
})

test('a turn that ends within two seconds never opens the pane', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.turn.start(turn)
  await w.clock.advance(500)
  await $.turn.complete(done)
  await w.clock.advance(5000)
  expect(w.opens).toBe(0)
})

test('stays out when switched off or not linked', async ($, on) => {
  const w = world(on, { isOn: false })
  await $.session.start(START)
  await $.turn.start(turn)
  await w.clock.advance(5000)
  expect(w.opens).toBe(0)
  expect(w.requests).toEqual([])
})

test('hands back three seconds after Claude finishes, with the score', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.turn.start(turn)
  await w.clock.advance(2100)
  await $.turn.complete(done)
  expect(w.closes).toBe(0)
  await w.clock.advance(3100)
  expect(w.closes).toBe(1)
  expect(w.toasts.some(text => text.startsWith("Claude's done"))).toBe(true)
})

test('an interrupted turn closes at once', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.turn.start(turn)
  await w.clock.advance(2100)
  await $.turn.complete({ ...done, isAborted: true, reason: 'aborted' })
  expect(w.closes).toBe(1)
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

test('a permission prompt pulls out, and the answered call drops back in', async ($, on) => {
  const w = world(on, { check: 'ask' })
  await $.session.start(START)
  await $.turn.start(turn)
  await w.clock.advance(2100)
  await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 'tu1' })
  expect(w.closes).toBe(1)
  expect(w.toasts).toContain('Claude needs you')
  await $.tool.call({ tool: 'Bash', tool_use_id: 'tu1', command: 'rm -rf build' } as never)
  await w.clock.advance(2100)
  expect(w.opens).toBe(2)
})

test('a question for the person pulls out', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.turn.start(turn)
  await w.clock.advance(2100)
  await $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'tu2', questions: [] } as never)
  expect(w.closes).toBe(1)
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
  const pane = await $.ui.mount({ plugin: 'wep', surface: 'terminal', component: 'Pane', requestId: 'wep', props: PANE_PROPS })
  await w.clock.advance(1500)
  const right = (await pane.findAll({ type: 'Button' })).find(button => button.text?.includes('Hello friend'))
  expect(right).toBeDefined()
  await pane.press({ key: String(right?.key) })
  expect(w.records.length).toBe(1)
  expect(w.records[0]?.isCorrect).toBe(true)
  expect(w.records[0]?.level).toBe(3)
  expect(w.records[0]?.reactionTimeMs).toBe(1500)
  await pane.unmount()
})

test('time spent handed back to Claude is not counted against the answer', async ($, on) => {
  const w = world(on, { check: 'ask' })
  await $.session.start(START)
  await $.turn.start(turn)
  await w.clock.advance(2000)
  await w.clock.advance(1000)
  await $.tool.check({ tool: 'Bash', input: {}, tool_use_id: 'tu1' })
  await w.clock.advance(60_000)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'tu1', command: 'ls' } as never)
  await w.clock.advance(2000)
  const pane = await $.ui.mount({ plugin: 'wep', surface: 'terminal', component: 'Pane', requestId: 'wep', props: PANE_PROPS })
  await w.clock.advance(500)
  const right = (await pane.findAll({ type: 'Button' })).find(button => button.text?.includes('Hello friend'))
  await pane.press({ key: String(right?.key) })
  expect(w.records[0]?.reactionTimeMs).toBe(1500)
  await pane.unmount()
})

test('running out of time counts as a miss', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.turn.start(turn)
  await w.clock.advance(2100)
  await w.clock.advance(10_100)
  expect(w.records.length).toBe(1)
  expect(w.records[0]?.isCorrect).toBe(false)
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
