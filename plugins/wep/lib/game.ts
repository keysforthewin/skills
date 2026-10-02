// A round of each mode, as the web app plays it, with nothing of the terminal
// or the network in it. Ported from the web app's Level1.vue, Level2.vue and
// Level3.vue (queue order, options) and useIqrTimeout.js (time limit), so the
// two clients ask, order and time an item the same way.

import type { WepOption } from '../types'

export type Confusable = {
  native?: string
  english?: string[]
  resolvedEnglish?: string[]
  transliterations?: Record<string, string>
  resolvedTransliterations?: Record<string, string>
}

/** Levels 1-3, or the review of words that went extinct at Level 1. */
export type Mode = 1 | 2 | 3 | 'extinction'

export type Item = {
  itemId: string
  targetText: string
  /** letter, matra, conjunct, word, fragment or phrase. */
  type?: string
  /** Level 2: the word the server blanked out of the phrase. */
  blankWord?: Item
  english?: string[]
  transliterations?: Record<string, string>
  confusables?: Confusable[]
  /** The item spoken, on the server's audio route; absent or null when it has no recording. */
  audioKey?: string | null
  /** Seconds into the recording where the speech starts and ends; an end of 0 is the recording's own. */
  audioTrimStart?: number
  audioTrimEnd?: number
  _priority?: { weight?: number }
}

export type Clip = { audioKey: string; startSeconds: number; endSeconds: number }

export type GameConfig = {
  level: Mode
  /** a: target phrase, English options. b: English phrase, target options. */
  mode: 'a' | 'b'
  difficulty: 'easy' | 'hard'
  transliteration: string
}

export type ItemStats = { correct: number; incorrect: number }

type Random = () => number

const MIN_SAMPLES = 5
const HARD_TIMEOUT_MS = 30000
const MIN_TIMEOUT_FLOOR_MS = 1500
const ROLLING_WINDOW = 50
// Level 2 and 3 start from a 7 s third quartile, Level 1 from 4 s.
const DEFAULT_Q3_MS = 7000
const SINGLE_ITEM_Q3_MS = 4000
const BLANK = '____'
const SCRIPT_TYPES = ['letter', 'matra', 'conjunct']
const CALIBRATION_BUFFER_MS = 3000
const CORRECT_SHRINK = 0.85
const INCORRECT_INFLATE = 1.5

const pick = <T>(list: readonly T[] | undefined, random: Random): T | undefined =>
  list && list.length > 0 ? list[Math.floor(random() * list.length)] : undefined

function romanized(transliterations: Record<string, string> | undefined, type: string): string {
  const all = transliterations ?? {}
  return all[type] || Object.values(all)[0] || ''
}

/** Level 1 and Extinction ask one item at a time; a letter is answered by how it reads. */
const isSingleItem = (config: GameConfig) => config.level === 1 || config.level === 'extinction'
const isScript = (item: Item, config: GameConfig) => isSingleItem(config) && SCRIPT_TYPES.includes(item.type ?? '')

export const defaultQ3Ms = (level: Mode) => (level === 1 || level === 'extinction' ? SINGLE_ITEM_Q3_MS : DEFAULT_Q3_MS)

export function promptOf(item: Item, config: GameConfig): { text: string; sub: string } {
  if (config.level === 2) {
    const text = config.mode === 'a' ? item.targetText : (item.english?.[0] ?? '')
    const blank = config.mode === 'a' ? item.blankWord?.targetText : item.blankWord?.english?.[0]

    // A phrase the blank word cannot be found in has nothing to fill.
    return { text: blank && text.includes(blank) ? text.replace(blank, BLANK) : '', sub: '' }
  }
  // Beside a letter, its romanised form would be the answer.
  if (config.mode === 'a' && isScript(item, config)) return { text: item.targetText, sub: '' }

  return config.mode === 'a'
    ? { text: item.targetText, sub: romanized(item.transliterations, config.transliteration) }
    : { text: item.english?.[0] ?? '', sub: '' }
}

/** What is spoken when the round is shown, or once it is settled; null when nothing is. */
export function clipOf(item: Item, config: GameConfig, moment: 'shown' | 'settled'): Clip | null {
  // Asked in English, a single item's sound would be its answer, so it waits for the answer.
  const isHeldBack = isSingleItem(config) && config.mode === 'b'
  if (!item.audioKey || isHeldBack !== (moment === 'settled')) return null

  return { audioKey: item.audioKey, startSeconds: item.audioTrimStart || 0, endSeconds: item.audioTrimEnd || 0 }
}

/** An item the round can be played on: it has a prompt and something to confuse it with. */
export function isPlayable(item: Item, config: GameConfig): boolean {
  return promptOf(item, config).text !== '' && buildOptions(item, config, () => 0).length > 1
}

export function buildOptions(asked: Item, config: GameConfig, random: Random = Math.random): WepOption[] {
  const item = config.level === 2 ? asked.blankWord : asked
  if (!item) return []

  const asOption = (source: Item | Confusable, isCorrect: boolean): WepOption => {
    if (isScript(item, config)) {
      const transliterations = isCorrect
        ? item.transliterations
        : (source as Confusable).resolvedTransliterations || source.transliterations

      return { text: romanized(transliterations, config.transliteration), sub: '', isCorrect }
    }

    if (config.mode === 'a') {
      const confusable = source as Confusable
      const english = isCorrect
        ? pick(item.english, random)
        : pick(confusable.resolvedEnglish, random) || pick(confusable.english, random)

      return { text: english ?? '', sub: '', isCorrect }
    }

    const native = isCorrect ? item.targetText : (source as Confusable).native
    const transliterations = isCorrect
      ? item.transliterations
      : (source as Confusable).resolvedTransliterations || source.transliterations

    return { text: native ?? '', sub: romanized(transliterations, config.transliteration), isCorrect }
  }

  const correct = asOption(item, true)
  if (correct.text === '') return []

  // Two confusables that read the same would be one answer shown twice.
  const seen = new Set([correct.text.toLowerCase()])
  const distractors: WepOption[] = []
  for (const confusable of item.confusables ?? []) {
    const option = asOption(confusable, false)
    const key = option.text.toLowerCase()
    if (option.text === '' || seen.has(key)) continue
    seen.add(key)
    distractors.push(option)
  }

  const wanted = config.difficulty === 'easy' ? 2 : 3
  const options = [correct, ...shuffle(distractors, random).slice(0, wanted)]

  return options.length > 1 ? shuffle(options, random) : []
}

function shuffle<T>(list: readonly T[], random: Random): T[] {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j] as T, out[i] as T]
  }

  return out
}

/** Heaviest first: the server's weight, plus a boost for what went wrong this session. */
export function sortByWeight(
  items: readonly Item[],
  stats: ReadonlyMap<string, ItemStats>,
  random: Random = Math.random,
): Item[] {
  const weightOf = (item: Item) => {
    const seen = stats.get(item.itemId)
    const boost = seen && seen.incorrect > 0 ? 1 + seen.incorrect / (seen.correct + seen.incorrect) : 0

    return (item._priority?.weight || 1) + boost
  }

  return [...items].sort((a, b) => weightOf(b) - weightOf(a) || random() - 0.5)
}

/** A wrong answer comes back three to five items later, or last in a shorter queue. */
export function requeueAfterMiss(queue: readonly Item[], item: Item, random: Random = Math.random): Item[] {
  const at = Math.min(queue.length, 3 + Math.floor(random() * 3))

  return [...queue.slice(0, at), item, ...queue.slice(at)]
}

function percentile(sorted: readonly number[], p: number): number {
  const index = (p / 100) * (sorted.length - 1)
  const low = sorted[Math.floor(index)] ?? 0
  const high = sorted[Math.ceil(index)] ?? low

  return low + (high - low) * (index - Math.floor(index))
}

function thirdQuartile(samples: readonly number[], defaultMs: number): number {
  if (samples.length < MIN_SAMPLES) return defaultMs

  return Math.max(MIN_TIMEOUT_FLOOR_MS, percentile([...samples].sort((a, b) => a - b), 75))
}

/** How long a round may run before it counts as too slow. */
export function timeLimitMs(samples: readonly number[], timeoutBufferMs: number, defaultMs = DEFAULT_Q3_MS): number {
  const buffer = samples.length < MIN_SAMPLES ? CALIBRATION_BUFFER_MS : timeoutBufferMs

  return Math.min(thirdQuartile(samples, defaultMs) + buffer, HARD_TIMEOUT_MS)
}

/** The samples with one more answer: a right one tightens the limit, a wrong one loosens it. */
export function withSample(
  samples: readonly number[],
  elapsedMs: number,
  isCorrect: boolean,
  defaultMs = DEFAULT_Q3_MS,
): number[] {
  const scaled = elapsedMs * (isCorrect ? CORRECT_SHRINK : INCORRECT_INFLATE)
  const capped = Math.min(scaled, HARD_TIMEOUT_MS, thirdQuartile(samples, defaultMs) * 2)

  return [...samples, capped].slice(-ROLLING_WINDOW)
}
