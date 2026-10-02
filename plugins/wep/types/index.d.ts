export type WepOption = {
  /** What the option says: English in mode a, the target script in mode b. */
  text: string
  /** The romanised form beside a target-script option; '' when there is none. */
  sub: string
  isCorrect: boolean
}

export type WepScore = {
  correct: number
  attempts: number
  streak: number
  points: number
}

export type WepView =
  | {
      kind: 'message'
      title: string
      lines: string[]
      /** Whether the message offers the way back to the menu. */
      hasMenu: boolean
    }
  | {
      kind: 'menu'
      title: string
      choices: { label: string; sub: string }[]
      /** The choice played last, -1 when none has been. */
      last: number
    }
  | {
      kind: 'round'
      course: string
      /** The mode's name beside the course: 'Full Phrases', 'Extinction'. */
      modeLabel: string
      prompt: string
      promptSub: string
      /** Blanks trailing both prompt lines, different each round, so the last word is written over. */
      wipe: string
      options: WepOption[]
      /** The option pressed, -1 for a timeout, null while the round is open. */
      chosen: number | null
      /** Tenths of the time limit already spent, 0-10. */
      spent: number
      limitSeconds: number
      /** Long haul: the round has no time limit and waits for its answer. */
      isLongHaul: boolean
      /** Long haul: seconds until the next round, null when none is counting down. */
      nextInSeconds: number | null
      score: WepScore
      /** Whether the round has something to say again: sound is on and its clip may be heard now. */
      canReplay: boolean
      /** What the hand-back says over a frozen round ('' while playing). */
      notice: string
    }

declare module 'claude-code' {
  interface PluginState {
    wep: { view: WepView; isOffered: boolean }
  }
}
