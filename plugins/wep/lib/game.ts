// The Level 3 ("Full Phrases") round, as the web app plays it, with nothing
// of the terminal or the network in it. Ported from the web app's Level3.vue
// (queue order, options) and useIqrTimeout.js (time limit), so the two clients
// ask, order and time a phrase the same way.

import type { WepOption } from '../types'

export type Confusable = {
  native?: string
  english?: string[]
  resolvedEnglish?: string[]
  transliterations?: Record<string, string>
  resolvedTransliterations?: Record<string, string>
}

export type Item = {
  itemId: string
  targetText: string
  english?: string[]
  transliterations?: Record<string, string>
  confusables?: Confusable[]
  _priority?: { weight?: number }
}

export type GameConfig = {
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
const CALIBRATION_BUFFER_MS = 3000
const CORRECT_SHRINK = 0.85
const INCORRECT_INFLATE = 1.5

const pick = <T>(list: readonly T[] | undefined, random: Random): T | undefined =>
  list && list.length > 0 ? list[Math.floor(random() * list.length)] : undefined

function romanized(transliterations: Record<string, string> | undefined, type: string): string {
  const all = transliterations ?? {}
  return all[type] || Object.values(all)[0] || ''
}

export function promptOf(item: Item, config: GameConfig): { text: string; sub: string } {
  return config.mode === 'a'
    ? { text: item.targetText, sub: romanized(item.transliterations, config.transliteration) }
    : { text: item.english?.[0] ?? '', sub: '' }
}

/** An item the round can be played on: it has a prompt and something to confuse it with. */
export function isPlayable(item: Item, config: GameConfig): boolean {
  return promptOf(item, config).text !== '' && buildOptions(item, config, () => 0).length > 1
}

export function buildOptions(item: Item, config: GameConfig, random: Random = Math.random): WepOption[] {
  const asOption = (source: Item | Confusable, isCorrect: boolean): WepOption => {
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

function thirdQuartile(samples: readonly number[]): number {
  if (samples.length < MIN_SAMPLES) return DEFAULT_Q3_MS

  return Math.max(MIN_TIMEOUT_FLOOR_MS, percentile([...samples].sort((a, b) => a - b), 75))
}

/** How long a round may run before it counts as too slow. */
export function timeLimitMs(samples: readonly number[], timeoutBufferMs: number): number {
  const buffer = samples.length < MIN_SAMPLES ? CALIBRATION_BUFFER_MS : timeoutBufferMs

  return Math.min(thirdQuartile(samples) + buffer, HARD_TIMEOUT_MS)
}

/** The samples with one more answer: a right one tightens the limit, a wrong one loosens it. */
export function withSample(samples: readonly number[], elapsedMs: number, isCorrect: boolean): number[] {
  const scaled = elapsedMs * (isCorrect ? CORRECT_SHRINK : INCORRECT_INFLATE)
  const capped = Math.min(scaled, HARD_TIMEOUT_MS, thirdQuartile(samples) * 2)

  return [...samples, capped].slice(-ROLLING_WINDOW)
}
