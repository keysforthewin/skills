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
  | { kind: 'message'; title: string; lines: string[] }
  | {
      kind: 'round'
      course: string
      prompt: string
      promptSub: string
      options: WepOption[]
      /** The option pressed, -1 for a timeout, null while the round is open. */
      chosen: number | null
      /** Tenths of the time limit already spent, 0-10. */
      spent: number
      limitSeconds: number
      score: WepScore
      /** What the hand-back says over a frozen round ('' while playing). */
      notice: string
    }

declare module 'claude-code' {
  interface PluginState {
    wep: { view: WepView; isOffered: boolean }
  }
}
