import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import {
  buildOptions,
  defaultQ3Ms,
  isPlayable,
  promptOf,
  requeueAfterMiss,
  sortByWeight,
  timeLimitMs,
  withSample,
} from '../lib/game'
import type { GameConfig, Item, ItemStats, Mode } from '../lib/game'
import type { WepOption, WepScore, WepView } from '../types'

const PANE = 'wep'
const TITLE = 'Word Exchange Plaza'
const DROP_IN_DELAY_MS = 2000
const CORRECT_PAUSE_MS = 1200
const MISS_PAUSE_MS = 3000
const TICK_MS = 500
const PAIR_POLL_MS = 2000
const PERFECT_SESSION_MIN_ATTEMPTS = 10
const DEFAULT_COOLDOWN_SECONDS = 30
// Long haul: a skip this soon after the answer is the answering key, not a request.
const SKIP_GRACE_MS = 600
// Long haul: an answer later than this many time limits is recorded without its time.
const LATE_AFTER_LIMITS = 2

const MODES: { mode: Mode; label: string; sub: string; empty: string[] }[] = [
  { mode: 1, label: 'Level 1', sub: 'Reaction Time', empty: ['Nothing to practise at Level 1 right now.', 'Check back later.'] },
  {
    mode: 2,
    label: 'Level 2',
    sub: 'Fill in the Blank',
    empty: ['No phrases to fill in right now.', 'Build up Level 1 first, or check back later.'],
  },
  {
    mode: 3,
    label: 'Level 3',
    sub: 'Full Phrases',
    empty: ['No full phrases to practise right now.', 'Play Level 1 to unlock some, or check back later.'],
  },
  {
    mode: 'extinction',
    label: 'Extinction',
    sub: 'Review extinct words',
    empty: ['No extinct words to review.', 'Words go extinct as you master them at Level 1.'],
  },
]

const WELCOME: WepView = { kind: 'message', title: TITLE, lines: ['Loading…'], hasMenu: false }
const view = atom({ plugin: 'wep', key: 'view' } as const, WELCOME)
const isOffered = atom({ plugin: 'wep', key: 'isOffered' } as const, false)

type Session = {
  courseId: string
  course: string
  config: GameConfig
  timeoutBufferMs: number
  isLongHaul: boolean
  /** Long haul: how long an answered round stays up before the next one. */
  cooldownMs: number
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
  /** When the answer came, null while the round is open. */
  settledAt: number | null
  /** Long haul: when the next round starts by itself, null when it waits for the person. */
  nextAt: number | null
}

class ApiError extends Error {
  constructor(readonly status: number) {
    super(`Word Exchange Plaza answered ${status}`)
  }
}

/** The server is older than this mode: its link tokens cannot reach the mode's routes. */
class ModeUnavailable extends Error {}

// A hook's `$` may only be handed to functions declared at the top of this
// file, so the game's state lives here beside them rather than in `register`.
let baseUrl = 'https://wordexchangeplaza.com'

let isOn = false
let token: string | null = null
// Closed by hand: stays closed, across turns, until /wep opens it again.
let isDismissed = false
// idle: out of the way. waiting: drop-in armed. playing: the pane is up.
let phase: 'idle' | 'waiting' | 'playing' = 'idle'
let mode: Mode = 3
// The menu comes first in every session, then whenever it is asked for.
let isMenuUp = true
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
  update($, view, (): WepView => ({ kind: 'message', title: TITLE, lines, hasMenu: token !== null }))

const named = (of: Mode) => MODES.find(entry => entry.mode === of) ?? MODES[2]!

async function draw($: EngineInterface) {
  if (!session || !round) return
  const now = await $.clock.now()
  const elapsed = (round.frozenAt ?? now) - round.startedAt
  const prompt = promptOf(round.item, session.config)
  const next: WepView = {
    kind: 'round',
    course: session.course,
    modeLabel: named(session.config.level).sub,
    prompt: prompt.text,
    promptSub: prompt.sub,
    options: round.options,
    chosen: round.chosen,
    spent: Math.max(0, Math.min(10, Math.floor((elapsed / round.limitMs) * 10))),
    limitSeconds: Math.round(round.limitMs / 1000),
    isLongHaul: session.isLongHaul,
    nextInSeconds: round.nextAt === null ? null : Math.max(0, Math.ceil((round.nextAt - now) / 1000)),
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
  const courseId = String(course.data.courseId)
  const kinds: string[] = (course.data.transliterationTypes ?? []).map(String)
  const saved = settings.transliteration?.[course.data.targetLanguage]
  const transliteration = kinds.includes(saved) ? saved : (kinds[0] ?? saved ?? 'itrans')
  const direction: 'a' | 'b' = settings.gameMode === 'b' ? 'b' : 'a'
  // Level 3 kept its samples without the level in the key before there was a menu.
  const samples =
    (await $.store.get(`samples:${courseId}:${mode}:${direction}`)) ??
    (mode === 3 ? await $.store.get(`samples:${courseId}:${direction}`) : undefined)

  const loaded: Session = {
    courseId,
    course: String(course.data.title ?? courseId),
    config: {
      level: mode,
      mode: direction,
      difficulty: settings.difficultyMode === 'hard' ? 'hard' : 'easy',
      transliteration,
    },
    timeoutBufferMs: Number(settings.timeoutBuffer ?? 1000),
    isLongHaul: settings.longHaulMode === true,
    cooldownMs: Math.max(0, Number(settings.longHaulCooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS)) * 1000,
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
  const course = encodeURIComponent(into.courseId)
  const { level, mode: direction } = into.config
  let data: { items?: unknown }
  if (level === 'extinction') {
    try {
      data = (await api($, 'GET', `/api/extinction/items?courseId=${course}&mode=${direction}`)).data
    } catch (error) {
      // /api/me answered this token a moment ago, so a refusal here is the route's.
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) throw new ModeUnavailable()
      throw error
    }
  } else {
    data = (await api($, 'GET', `/api/gameplay/course/${course}/items?mode=${direction}&level=${level}`)).data
  }
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
    // An extinct word is reviewed once; the levels go round again.
    if (session.queue.length === 0 && session.config.level !== 'extinction') {
      session.queue = sortByWeight(session.pool, session.stats)
    }
  } catch (error) {
    if (error instanceof ModeUnavailable) {
      await showMessage($, 'Extinction needs a newer Word Exchange Plaza server.', 'Pick another mode for now.')
    } else if (!(await unlinkOn(error, $))) {
      await showMessage($, 'Could not reach Word Exchange Plaza.', 'Pick a mode to try again.')
    }

    return
  }
  // The pane may have stepped aside, or the menu come up, while the items loaded.
  if (phase !== 'playing' || isMenuUp) return

  const item = session.queue.shift()
  if (!item) {
    const isDone = session.config.level === 'extinction' && session.pool.length > 0
    const [first = '', second = ''] = isDone
      ? ['Extinction review done.', 'Every due word has been asked.']
      : named(mode).empty
    await showMessage($, first, second)

    return
  }

  round = {
    item,
    options: buildOptions(item, session.config),
    startedAt: await $.clock.now(),
    limitMs: timeLimitMs(session.samples, session.timeoutBufferMs, defaultQ3Ms(session.config.level)),
    frozenAt: null,
    chosen: null,
    settledAt: null,
    nextAt: null,
  }
  armRound($, round.limitMs)
  await draw($)
}

function armRound($: EngineInterface, remainingMs: number) {
  // Long haul has no time limit: the item waits until it is answered.
  if (session?.isLongHaul) return
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
  const now = await $.clock.now()
  const elapsedMs = Math.round(now - played.startedAt)
  played.frozenAt = played.startedAt + elapsedMs
  played.settledAt = now

  if (index === -1) {
    // Nobody was looking: the answer is shown, and nothing is counted or recorded.
    await draw($)
    roundTimers = [$.clock.after(MISS_PAUSE_MS, () => void startRound($))]

    return
  }

  const { level } = game.config
  const isLate = game.isLongHaul && elapsedMs > played.limitMs * LATE_AFTER_LIMITS
  const seen = game.stats.get(played.item.itemId) ?? { correct: 0, incorrect: 0 }
  game.stats.set(played.item.itemId, {
    correct: seen.correct + (isCorrect ? 1 : 0),
    incorrect: seen.incorrect + (isCorrect ? 0 : 1),
  })
  if (!isLate) game.samples = withSample(game.samples, elapsedMs, isCorrect, defaultQ3Ms(level))
  // A miss comes back soon, except an extinct word, which a miss sends back to its level.
  if (!isCorrect && level !== 'extinction') game.queue = requeueAfterMiss(game.queue, played.item)

  score.attempts += 1
  score.correct += isCorrect ? 1 : 0
  score.streak = isCorrect ? score.streak + 1 : 0
  if (!game.isLongHaul) {
    roundTimers = [$.clock.after(isCorrect ? CORRECT_PAUSE_MS : MISS_PAUSE_MS, () => void startRound($))]
  } else if (game.cooldownMs > 0) {
    played.nextAt = now + game.cooldownMs
    roundTimers = [
      $.clock.after(game.cooldownMs, () => void startRound($)),
      $.clock.every(TICK_MS, () => void draw($)),
    ]
  } else if (isCorrect) {
    // No cooldown: a right answer moves on, a wrong one waits to be read.
    roundTimers = [$.clock.after(CORRECT_PAUSE_MS, () => void startRound($))]
  }
  await draw($)

  try {
    await $.store.set(`samples:${game.courseId}:${level}:${game.config.mode}`, game.samples)
    const answered = {
      itemId: played.item.itemId,
      courseId: game.courseId,
      mode: game.config.mode,
      isCorrect,
      reactionTimeMs: isLate ? null : elapsedMs,
    }
    const { data } =
      level === 'extinction'
        ? await api($, 'POST', '/api/extinction/record', answered)
        : await api($, 'POST', '/api/gameplay/record', {
            ...answered,
            level,
            ...(level === 2 ? { blankWordItemId: played.item.blankWord?.itemId } : {}),
          })
    score.streak = Number(data.currentStreak ?? score.streak)
    score.points += Number(data.pointsAwarded ?? 0)
    if (level !== 'extinction' && (data.wentExtinct || data.tierAscended || data.levelComplete)) {
      await loadItems($, game)
    }
  } catch (error) {
    if (await unlinkOn(error, $)) clearRoundTimers()
  }
}

/** The person's skip past an answered round, as long haul's Next. */
async function skip($: EngineInterface) {
  if (phase !== 'playing' || !round || round.settledAt === null) return
  if ((await $.clock.now()) - round.settledAt < SKIP_GRACE_MS) return
  await startRound($)
}

async function showMenu($: EngineInterface) {
  isMenuUp = true
  await freeze($)
  const last = (await $.store.get('mode')) === undefined ? -1 : MODES.findIndex(entry => entry.mode === mode)
  await update(
    $,
    view,
    (): WepView => ({ kind: 'menu', title: TITLE, choices: MODES.map(({ label, sub }) => ({ label, sub })), last }),
  )
}

async function choose($: EngineInterface, picked: Mode) {
  if (phase !== 'playing') return
  isMenuUp = false
  // A mode with no round in flight ended on a message: picking it loads it afresh.
  if (picked !== mode || !round) await endSession($)
  mode = picked
  await $.store.set('mode', picked)
  await thaw($)
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
  if (isMenuUp) return showMenu($)
  if (!round || round.frozenAt === null || round.chosen !== null) return startRound($)
  const now = await $.clock.now()
  round.startedAt += now - round.frozenAt
  round.frozenAt = null
  armRound($, round.limitMs - (now - round.startedAt))
  await draw($)
}

function armDropIn($: EngineInterface) {
  if (!isOn || !token || isDismissed || phase !== 'idle') return
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
  const wasUp = phase === 'playing'
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
  if (!game || !token || game.config.level === 'extinction') return
  if (score.attempts < PERFECT_SESSION_MIN_ATTEMPTS || score.correct !== score.attempts) return
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
    const saved = await $.store.get('mode')
    mode = MODES.find(entry => entry.mode === saved)?.mode ?? mode
    await $.command.register({
      name: 'wep',
      description: 'Play Word Exchange Plaza while Claude works',
      argumentHint: '[menu|hide|off|unlink]',
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

    if (arg === 'hide') {
      isDismissed = true
      await goAway($)

      return { text: 'Word Exchange Plaza is hidden. Run /wep to bring it back.' }
    }

    isOn = true
    isDismissed = false
    await $.store.set('isOn', true)
    try {
      if (!token) return { text: await startPairing($) }
    } catch {
      return { text: `Could not reach ${baseUrl}. Try /wep again in a moment.` }
    }
    if (arg === 'menu') isMenuUp = true
    if (phase !== 'playing') await dropIn($)
    else if (arg === 'menu') await showMenu($)

    return {
      text: 'Word Exchange Plaza is on: it stays open while you work and steps aside when Claude needs you. /wep menu changes mode, /wep hide closes it.',
    }
  })

  on('turn.start', async ($, e, next) => {
    armDropIn($)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // A subagent finishing is not Claude finishing.
    if (e.agentId) return next(e)
    // The pane stays up between turns: closing it here made it flap each time
    // a background agent woke Claude. Only a turn too short to open it is let go.
    if (phase === 'waiting') await goAway($)
    else if (phase === 'playing' && !e.isAborted) $.ui.toast(`Claude's done${tally()}`)

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
      isDismissed = true
      phaseTimer?.cancel()
      phase = 'idle'
      await freeze($)
    }

    return next(e)
  })

  on('ui.render', { component: 'Spinner' }, ($, e, next) =>
    isOn && score.attempts > 0
      ? next({ ...e, props: { ...e.props, suffix: ` · ${score.correct}/${score.attempts} right…` } })
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

    const menu = <Button key="menu" hotkey="m" plain label="Menu" onPress={() => showMenu($)} />

    if (shown.kind === 'message') {
      return (
        <Box flexDirection="column">
          <Text bold>{shown.title}</Text>
          {shown.lines.map(line => (
            <Text dimColor>{line}</Text>
          ))}
          {shown.hasMenu && menu}
        </Box>
      )
    }

    if (shown.kind === 'menu') {
      return (
        <Box flexDirection="column">
          <Text bold>{shown.title} · pick a mode</Text>
          {shown.choices.map((choice, index) => (
            <Button
              key={`mode-${index}`}
              hotkey={String(index + 1)}
              plain
              label={`${choice.label} · ${choice.sub}${index === shown.last ? '  (last played)' : ''}`}
              onPress={() => choose($, MODES[index]!.mode)}
            />
          ))}
        </Box>
      )
    }

    const isOpen = shown.chosen === null && shown.notice === ''
    const label = (option: WepOption) => (option.sub ? `${option.text}  (${option.sub})` : option.text)
    const verdict =
      shown.chosen === null
        ? ''
        : shown.options[shown.chosen]?.isCorrect
          ? 'Correct'
          : shown.chosen === -1
            ? 'Timed out · not counted'
            : 'Not quite'
    const countdown =
      shown.nextInSeconds === null
        ? ''
        : ` · next in ${Math.floor(shown.nextInSeconds / 60)}:${String(shown.nextInSeconds % 60).padStart(2, '0')}`
    const waiting = shown.isLongHaul
      ? 'Long haul · no time limit'
      : `${'█'.repeat(10 - shown.spent)}${'░'.repeat(shown.spent)}  ${shown.limitSeconds}s`

    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Text dimColor>
            {shown.course} · {shown.modeLabel}
          </Text>
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
        <Box justifyContent="space-between">
          <Text key="status" dimColor={verdict === ''}>
            {shown.notice || (verdict ? verdict + countdown : waiting)}
          </Text>
          <Box>
            {shown.isLongHaul && verdict !== '' && (
              <Button key="next" hotkey="n" plain label="Next  " onPress={() => skip($)} />
            )}
            {menu}
          </Box>
        </Box>
      </Box>
    )
  })
}
