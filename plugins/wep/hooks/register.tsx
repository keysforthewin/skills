import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import {
  buildOptions,
  isPlayable,
  promptOf,
  requeueAfterMiss,
  sortByWeight,
  timeLimitMs,
  withSample,
} from '../lib/game'
import type { GameConfig, Item, ItemStats } from '../lib/game'
import type { WepOption, WepScore, WepView } from '../types'

const PANE = 'wep'
const TITLE = 'Word Exchange Plaza'
const DROP_IN_DELAY_MS = 2000
const HAND_BACK_MS = 3000
const CORRECT_PAUSE_MS = 1200
const MISS_PAUSE_MS = 3000
const TICK_MS = 500
const PAIR_POLL_MS = 2000
const PERFECT_SESSION_MIN_ATTEMPTS = 10

const WELCOME: WepView = { kind: 'message', title: TITLE, lines: ['Loading your phrases…'] }
const view = atom({ plugin: 'wep', key: 'view' } as const, WELCOME)
const isOffered = atom({ plugin: 'wep', key: 'isOffered' } as const, false)

type Session = {
  courseId: string
  course: string
  config: GameConfig
  timeoutBufferMs: number
  pool: Item[]
  queue: Item[]
  stats: Map<string, ItemStats>
  /** Scaled answer times the time limit is worked out from, kept per course and mode. */
  samples: number[]
}

type Round = {
  item: Item
  options: WepOption[]
  /** When the clock started, moved forward by every freeze so paused time never counts. */
  startedAt: number
  limitMs: number
  frozenAt: number | null
  chosen: number | null
}

class ApiError extends Error {
  constructor(readonly status: number) {
    super(`Word Exchange Plaza answered ${status}`)
  }
}

// A hook's `$` may only be handed to functions declared at the top of this
// file, so the game's state lives here beside them rather than in `register`.
let baseUrl = 'https://wordexchangeplaza.com'

let isOn = false
let token: string | null = null
let isTurnRunning = false
let isDismissed = false
// idle: out of the way. waiting: a turn began, drop-in armed. playing: the
// pane is up. handing-back: Claude finished, the pane closes in a moment.
let phase: 'idle' | 'waiting' | 'playing' | 'handing-back' = 'idle'
let phaseTimer: Timer | undefined
let session: Session | null = null
let round: Round | null = null
let roundTimers: Timer[] = []
let pairing: Timer | undefined
let notice = ''
const score: WepScore = { correct: 0, attempts: 0, streak: 0, points: 0 }

async function api($: EngineInterface, method: string, path: string, body?: unknown, auth = true) {
  const response = await $.http.fetch(baseUrl + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok && response.status !== 202) throw new ApiError(response.status)

  return { status: response.status, data: JSON.parse(response.text || '{}') }
}

const showMessage = ($: EngineInterface, ...lines: string[]) =>
  update($, view, (): WepView => ({ kind: 'message', title: TITLE, lines }))

async function draw($: EngineInterface) {
  if (!session || !round) return
  const elapsed = (round.frozenAt ?? (await $.clock.now())) - round.startedAt
  const prompt = promptOf(round.item, session.config)
  const next: WepView = {
    kind: 'round',
    course: session.course,
    prompt: prompt.text,
    promptSub: prompt.sub,
    options: round.options,
    chosen: round.chosen,
    spent: Math.max(0, Math.min(10, Math.floor((elapsed / round.limitMs) * 10))),
    limitSeconds: Math.round(round.limitMs / 1000),
    score: { ...score },
    notice,
  }
  await update($, view, () => next)
}

function clearRoundTimers() {
  for (const timer of roundTimers) timer.cancel()
  roundTimers = []
}

async function loadSession($: EngineInterface): Promise<Session> {
  const [me, course] = await Promise.all([
    api($, 'GET', '/api/me'),
    api($, 'GET', '/api/gameplay/course'),
  ])
  const settings = me.data.settings ?? {}
  const mode: 'a' | 'b' = settings.gameMode === 'b' ? 'b' : 'a'
  const courseId = String(course.data.courseId)
  const kinds: string[] = (course.data.transliterationTypes ?? []).map(String)
  const saved = settings.transliteration?.[course.data.targetLanguage]
  const transliteration = kinds.includes(saved) ? saved : (kinds[0] ?? saved ?? 'itrans')
  const samples = await $.store.get(`samples:${courseId}:${mode}`)

  const loaded: Session = {
    courseId,
    course: String(course.data.title ?? courseId),
    config: { mode, difficulty: settings.difficultyMode === 'hard' ? 'hard' : 'easy', transliteration },
    timeoutBufferMs: Number(settings.timeoutBuffer ?? 1000),
    pool: [],
    queue: [],
    stats: new Map(),
    samples: Array.isArray(samples) ? samples.map(Number) : [],
  }
  score.streak = Number(me.data.currentStreak ?? 0)
  await loadItems($, loaded)

  return loaded
}

async function loadItems($: EngineInterface, into: Session) {
  const { data } = await api(
    $,
    'GET',
    `/api/gameplay/course/${encodeURIComponent(into.courseId)}/items?mode=${into.config.mode}&level=3`,
  )
  const items: Item[] = Array.isArray(data.items) ? data.items : []
  into.pool = items.filter(item => isPlayable(item, into.config))
  into.queue = sortByWeight(into.pool, into.stats)
}

async function unlinkOn(error: unknown, $: EngineInterface): Promise<boolean> {
  if (!(error instanceof ApiError) || (error.status !== 401 && error.status !== 403)) return false
  token = null
  session = null
  await $.store.delete('link')
  await showMessage($, 'This terminal is no longer linked.', 'Run /wep to link it again.')

  return true
}

async function startRound($: EngineInterface) {
  round = null
  clearRoundTimers()
  try {
    if (!session) {
      await update($, view, () => WELCOME)
      session = await loadSession($)
    }
    if (session.queue.length === 0) session.queue = sortByWeight(session.pool, session.stats)
  } catch (error) {
    if (!(await unlinkOn(error, $))) {
      await showMessage($, 'Could not reach Word Exchange Plaza.', 'It will try again on the next turn.')
    }

    return
  }
  // The hand-back may have come while the phrases loaded.
  if (phase !== 'playing') return

  const item = session.queue.shift()
  if (!item) {
    await showMessage(
      $,
      'No full phrases to practise right now.',
      'Play Level 1 on the web to unlock some, or check back later.',
    )

    return
  }

  round = {
    item,
    options: buildOptions(item, session.config),
    startedAt: await $.clock.now(),
    limitMs: timeLimitMs(session.samples, session.timeoutBufferMs),
    frozenAt: null,
    chosen: null,
  }
  armRound($, round.limitMs)
  await draw($)
}

function armRound($: EngineInterface, remainingMs: number) {
  roundTimers = [
    $.clock.after(Math.max(0, remainingMs), () => void answer($, -1)),
    $.clock.every(TICK_MS, () => void draw($)),
  ]
}

/** Settles the open round: `index` is the option pressed, -1 when time ran out. */
async function answer($: EngineInterface, index: number) {
  if (phase !== 'playing' || !session || !round || round.chosen !== null || round.frozenAt !== null) return
  const played = round
  const game = session
  clearRoundTimers()
  played.chosen = index

  const isCorrect = played.options[index]?.isCorrect === true
  const elapsedMs = Math.round((await $.clock.now()) - played.startedAt)
  played.frozenAt = played.startedAt + elapsedMs

  const seen = game.stats.get(played.item.itemId) ?? { correct: 0, incorrect: 0 }
  game.stats.set(played.item.itemId, {
    correct: seen.correct + (isCorrect ? 1 : 0),
    incorrect: seen.incorrect + (isCorrect ? 0 : 1),
  })
  game.samples = withSample(game.samples, elapsedMs, isCorrect)
  // A miss comes back soon; a timeout waits for the next pass, as on the web.
  if (!isCorrect && index !== -1) game.queue = requeueAfterMiss(game.queue, played.item)

  score.attempts += 1
  score.correct += isCorrect ? 1 : 0
  score.streak = isCorrect ? score.streak + 1 : 0
  await draw($)
  roundTimers = [$.clock.after(isCorrect ? CORRECT_PAUSE_MS : MISS_PAUSE_MS, () => void startRound($))]

  try {
    await $.store.set(`samples:${game.courseId}:${game.config.mode}`, game.samples)
    const { data } = await api($, 'POST', '/api/gameplay/record', {
      itemId: played.item.itemId,
      courseId: game.courseId,
      mode: game.config.mode,
      level: 3,
      isCorrect,
      reactionTimeMs: elapsedMs,
    })
    score.streak = Number(data.currentStreak ?? score.streak)
    score.points += Number(data.pointsAwarded ?? 0)
    if (data.wentExtinct || data.tierAscended || data.levelComplete) await loadItems($, game)
  } catch (error) {
    if (await unlinkOn(error, $)) clearRoundTimers()
  }
}

/** Stops the clock: an open round keeps its place, a settled one is dropped. */
async function freeze($: EngineInterface) {
  clearRoundTimers()
  if (!round) return
  if (round.chosen !== null) round = null
  else if (round.frozenAt === null) round.frozenAt = await $.clock.now()
}

async function thaw($: EngineInterface) {
  notice = ''
  if (!round || round.frozenAt === null || round.chosen !== null) return startRound($)
  const now = await $.clock.now()
  round.startedAt += now - round.frozenAt
  round.frozenAt = null
  armRound($, round.limitMs - (now - round.startedAt))
  await draw($)
}

function armDropIn($: EngineInterface) {
  if (!isOn || !token || !isTurnRunning || isDismissed || phase !== 'idle') return
  phase = 'waiting'
  phaseTimer = $.clock.after(DROP_IN_DELAY_MS, () => void dropIn($))
}

async function dropIn($: EngineInterface) {
  phaseTimer?.cancel()
  phase = 'playing'
  const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true, rows: 9 })
  if (!opened.isPlaced) {
    // Too narrow for a pane the person did not ask for: offer it instead.
    phase = 'idle'
    await $.ui.close({ id: PANE })
    await update($, isOffered, () => true)

    return
  }
  await update($, isOffered, () => false)
  await thaw($)
}

async function goAway($: EngineInterface, toast?: string) {
  phaseTimer?.cancel()
  const wasUp = phase === 'playing' || phase === 'handing-back'
  phase = 'idle'
  await update($, isOffered, () => false)
  if (!wasUp) return
  await freeze($)
  await $.ui.close({ id: PANE })
  if (toast) $.ui.toast(toast)
}

const tally = () =>
  score.attempts === 0 ? '' : ` · ${score.correct}/${score.attempts} right, streak ${score.streak}`

async function endSession($: EngineInterface) {
  const game = session
  session = null
  round = null
  if (!game || !token || score.attempts < PERFECT_SESSION_MIN_ATTEMPTS || score.correct !== score.attempts) return
  try {
    await api($, 'POST', '/api/gameplay/session-end', {
      courseId: game.courseId,
      totalAttempts: score.attempts,
      totalCorrect: score.correct,
    })
  } catch {
    // The badge is a bonus; a session that cannot report it still ends.
  }
}

async function openBrowser($: EngineInterface, url: string) {
  const openers = [['wslview', url], ['cmd.exe', '/c', 'start', '', url], ['xdg-open', url], ['open', url]]
  for (const argv of openers) {
    try {
      if ((await $.process.run(argv, { timeoutMs: 5000 })).exitCode === 0) return
    } catch {
      // Not on this machine: try the next one. The link is printed either way.
    }
  }
}

async function startPairing($: EngineInterface): Promise<string> {
  const { data } = await api($, 'POST', '/api/claude-link/pair', {}, false)
  const url = `${baseUrl}/dashboard/claude-link?code=${data.code}`
  let isAsking = false
  const expiresAt = (await $.clock.now()) + Number(data.expiresInSeconds ?? 600) * 1000

  pairing?.cancel()
  pairing = $.clock.every(PAIR_POLL_MS, () => {
    if (isAsking) return
    isAsking = true
    void (async () => {
      try {
        const polled = await api($, 'POST', '/api/claude-link/poll', { pollSecret: data.pollSecret }, false)
        if (polled.status === 200) {
          pairing?.cancel()
          token = String(polled.data.token)
          await $.store.set('link', { token, baseUrl })
          $.ui.toast(`Linked as ${polled.data.name}. Word Exchange Plaza drops in while Claude works.`)
          armDropIn($)
        } else if ((await $.clock.now()) > expiresAt) {
          pairing?.cancel()
        }
      } catch {
        pairing?.cancel()
        $.ui.toast('That link expired. Run /wep for a new one.')
      } finally {
        isAsking = false
      }
    })()
  })
  void openBrowser($, url)

  return `Open this link to connect your Word Exchange Plaza account, and check the code matches ${data.code}:\n${url}`
}

export const register: Register = (on, options) => {
  baseUrl = String(options.baseUrl ?? baseUrl).replace(/\/+$/, '')

  on('session.start', async ($, e, next) => {
    const link = (await $.store.get('link')) as { token?: string; baseUrl?: string } | undefined
    token = link?.token && link.baseUrl === baseUrl ? link.token : null
    isOn = (await $.store.get('isOn')) === true
    await $.command.register({
      name: 'wep',
      description: 'Play Word Exchange Plaza while Claude works',
      argumentHint: '[off|unlink]',
      immediate: true,
    })

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await endSession($)

    return next(e)
  })

  on('command.run', { command: 'wep' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'off' || arg === 'unlink') {
      isOn = false
      await $.store.set('isOn', false)
      await goAway($)
      await endSession($)
      if (arg === 'off') return { text: 'Word Exchange Plaza is off. Run /wep to turn it back on.' }
      token = null
      pairing?.cancel()
      await $.store.delete('link')

      return { text: 'This terminal is unlinked from Word Exchange Plaza.' }
    }

    isOn = true
    isDismissed = false
    await $.store.set('isOn', true)
    try {
      if (!token) return { text: await startPairing($) }
    } catch {
      return { text: `Could not reach ${baseUrl}. Try /wep again in a moment.` }
    }
    if (phase !== 'playing') await dropIn($)

    return { text: 'Word Exchange Plaza is on: it drops in while Claude works and steps aside when Claude needs you.' }
  })

  on('turn.start', async ($, e, next) => {
    isTurnRunning = true
    isDismissed = false
    if (phase === 'handing-back') {
      // A queued prompt started before the pane closed: keep playing.
      phaseTimer?.cancel()
      phase = 'playing'
      await thaw($)
    } else {
      armDropIn($)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // A subagent finishing is not Claude finishing.
    if (e.agentId) return next(e)
    isTurnRunning = false
    if (phase === 'playing' && !e.isAborted) {
      await freeze($)
      phase = 'handing-back'
      notice = "Claude's done · handing you back"
      await draw($)
      phaseTimer = $.clock.after(HAND_BACK_MS, () => void goAway($, `Claude's done${tally()}`))
    } else {
      await goAway($)
    }

    return next(e)
  })

  on('tool.check', async ($, e, next) => {
    const result = await next(e)
    if (e.tool_use_id && result.decision === 'ask') await goAway($, 'Claude needs you')

    return result
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'AskUserQuestion') await goAway($, 'Claude needs you')
    const ran = await next(e)
    // Once an answered prompt lets Claude carry on, drop back in.
    armDropIn($)

    return ran
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') {
      // Closed by hand: stay out for the rest of this turn.
      isDismissed = isTurnRunning
      phaseTimer?.cancel()
      phase = 'idle'
      await freeze($)
    }

    return next(e)
  })

  on('ui.render', { component: 'Spinner' }, ($, e, next) =>
    isOn && score.attempts > 0
      ? next({ ...e, props: { ...e.props, suffix: ` · ${score.correct}/${score.attempts} phrases right…` } })
      : next(e),
  )

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isOffered))) return next(e)
    const { Box, Button } = $.ui.resolve(e)

    return (
      <Box>
        <Button key="play" hotkey="1" plain label="Play Word Exchange Plaza while Claude works" onPress={() => dropIn($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const shown = await read($, view)

    if (shown.kind === 'message') {
      return (
        <Box flexDirection="column">
          <Text bold>{shown.title}</Text>
          {shown.lines.map(line => (
            <Text dimColor>{line}</Text>
          ))}
        </Box>
      )
    }

    const isOpen = shown.chosen === null && shown.notice === ''
    const label = (option: WepOption) => (option.sub ? `${option.text}  (${option.sub})` : option.text)
    const verdict = shown.chosen === null ? '' : shown.options[shown.chosen]?.isCorrect ? 'Correct' : shown.chosen === -1 ? 'Too slow' : 'Not quite'

    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Text dimColor>{shown.course} · Full Phrases</Text>
          <Text dimColor>
            streak {shown.score.streak} · {shown.score.correct}/{shown.score.attempts} this session
          </Text>
        </Box>
        <Text bold>{shown.prompt}</Text>
        {shown.promptSub !== '' && <Text dimColor>{shown.promptSub}</Text>}
        <Box flexDirection="column" marginTop={1}>
          {shown.options.map((option, index) =>
            isOpen ? (
              <Button key={`option-${index}`} hotkey={String(index + 1)} plain label={label(option)} onPress={() => answer($, index)} />
            ) : (
              <Text
                key={`option-${index}`}
                bold={option.isCorrect && shown.chosen !== null}
                dimColor={!(option.isCorrect && shown.chosen !== null) && shown.chosen !== index}
                strikethrough={shown.chosen === index && !option.isCorrect}
              >
                {index + 1}: {label(option)}
              </Text>
            ),
          )}
        </Box>
        <Text key="status" dimColor={verdict === ''}>
          {shown.notice ||
            verdict ||
            `${'█'.repeat(10 - shown.spent)}${'░'.repeat(shown.spent)}  ${shown.limitSeconds}s`}
        </Text>
      </Box>
    )
  })
}
