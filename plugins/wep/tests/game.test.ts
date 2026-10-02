import { describe, expect, test } from 'claude-code/testing'

import { buildOptions, isPlayable, promptOf, requeueAfterMiss, sortByWeight, timeLimitMs, withSample } from '../lib/game'
import type { GameConfig, Item } from '../lib/game'

const modeA: GameConfig = { mode: 'a', difficulty: 'hard', transliteration: 'itrans' }
const modeB: GameConfig = { ...modeA, mode: 'b' }

const phrase: Item = {
  itemId: 'p1',
  targetText: 'मुझे पानी चाहिए',
  english: ['I need water'],
  transliterations: { itrans: 'mujhe pAnI chAhie' },
  confusables: [
    { native: 'मुझे चाय चाहिए', resolvedEnglish: ['I need tea'], resolvedTransliterations: { itrans: 'mujhe chAy chAhie' } },
    { native: 'मुझे दूध चाहिए', resolvedEnglish: ['I need milk'], resolvedTransliterations: { itrans: 'mujhe dUdh chAhie' } },
    { native: 'मुझे खाना चाहिए', resolvedEnglish: ['I need food'], resolvedTransliterations: { itrans: 'mujhe khAnA chAhie' } },
    { native: 'मुझे नींद चाहिए', resolvedEnglish: ['I need sleep'], resolvedTransliterations: { itrans: 'mujhe nIMd chAhie' } },
    // Reads the same as the answer in English: never a second "I need water".
    { native: 'मुझे जल चाहिए', resolvedEnglish: ['I need water'], resolvedTransliterations: { itrans: 'mujhe jal chAhie' } },
  ],
}

describe('options', () => {
  test('hard shows four, easy three, one of them right', () => {
    for (let run = 0; run < 20; run++) {
      const hard = buildOptions(phrase, modeA)
      const easy = buildOptions(phrase, { ...modeA, difficulty: 'easy' })
      expect(hard.length).toBe(4)
      expect(easy.length).toBe(3)
      expect(hard.filter(option => option.isCorrect).length).toBe(1)
      expect(easy.filter(option => option.isCorrect).length).toBe(1)
    }
  })

  test('never shows the answer twice under another phrase', () => {
    for (let run = 0; run < 50; run++) {
      const texts = buildOptions(phrase, modeA).map(option => option.text)
      expect(new Set(texts).size).toBe(texts.length)
      expect(texts.filter(text => text === 'I need water').length).toBe(1)
    }
  })

  test('mode a asks in the target script with its romanised form, and answers in English', () => {
    expect(promptOf(phrase, modeA)).toEqual({ text: 'मुझे पानी चाहिए', sub: 'mujhe pAnI chAhie' })
    const correct = buildOptions(phrase, modeA).find(option => option.isCorrect)
    expect(correct).toEqual({ text: 'I need water', sub: '', isCorrect: true })
  })

  test('mode b asks in English, and every target-script option carries its romanised form', () => {
    expect(promptOf(phrase, modeB)).toEqual({ text: 'I need water', sub: '' })
    const options = buildOptions(phrase, modeB)
    expect(options.find(option => option.isCorrect)).toEqual({
      text: 'मुझे पानी चाहिए',
      sub: 'mujhe pAnI chAhie',
      isCorrect: true,
    })
    expect(options.every(option => option.sub !== '')).toBe(true)
  })

  test('an item with nothing to confuse it with is not playable', () => {
    expect(isPlayable({ ...phrase, confusables: [] }, modeA)).toBe(false)
    expect(isPlayable({ ...phrase, english: [] }, modeB)).toBe(false)
    expect(isPlayable(phrase, modeA)).toBe(true)
  })
})

describe('queue', () => {
  const items: Item[] = ['light', 'heavy', 'missed'].map((itemId, index) => ({
    itemId,
    targetText: itemId,
    _priority: { weight: [1, 3, 2][index] },
  }))

  test('plays the heaviest first, and what went wrong this session before its weight says', () => {
    expect(sortByWeight(items, new Map()).map(item => item.itemId)).toEqual(['heavy', 'missed', 'light'])
    const stats = new Map([['missed', { correct: 0, incorrect: 2 }]])
    expect(sortByWeight(items, stats).map(item => item.itemId)).toEqual(['missed', 'heavy', 'light'])
  })

  test('a miss comes back three to five items later', () => {
    const queue: Item[] = Array.from({ length: 8 }, (_, index) => ({ itemId: `q${index}`, targetText: '' }))
    for (let run = 0; run < 30; run++) {
      const at = requeueAfterMiss(queue, phrase).findIndex(item => item.itemId === 'p1')
      expect(at >= 3 && at <= 5).toBe(true)
    }
    expect(requeueAfterMiss(queue.slice(0, 1), phrase).map(item => item.itemId)).toEqual(['q0', 'p1'])
  })
})

describe('time limit', () => {
  test('is ten seconds while there are fewer than five answers to go on', () => {
    expect(timeLimitMs([], 1000)).toBe(10000)
    expect(timeLimitMs([2000, 2000, 2000, 2000], 1000)).toBe(10000)
  })

  test('then follows the third quartile plus the buffer, within its floor and ceiling', () => {
    expect(timeLimitMs([2000, 3000, 4000, 5000, 6000], 1000)).toBe(6000)
    expect(timeLimitMs([500, 500, 500, 500, 500], 1000)).toBe(2500)
    expect(timeLimitMs([29000, 29500, 30000, 30000, 30000], 1000)).toBe(30000)
  })

  test('a right answer tightens it, a wrong one loosens it, and it keeps the last fifty', () => {
    expect(withSample([], 2000, true)).toEqual([1700])
    expect(withSample([], 2000, false)).toEqual([3000])
    const full = Array.from({ length: 50 }, () => 3000)
    const next = withSample(full, 2000, true)
    expect(next.length).toBe(50)
    expect(next[49]).toBe(1700)
  })
})
