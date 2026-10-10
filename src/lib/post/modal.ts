// ============================================================
// Modal-state machine for G-code emission (C-P1a)
// ============================================================
// Controllers are modal: a word (motion mode, X/Y/Z, F, S) persists until a
// later block changes it. To keep output compact and unambiguous we emit a
// word ONLY when its value differs from what was last emitted. forceReset()
// clears the memory so the next block re-emits everything — used at section
// and tool-change boundaries where a fully-qualified block is safer.

import { dimWord, sWord, word, type PostUnits } from './format'

export interface ModalState {
  /** Append the X/Y/Z words that changed since the last emission. Updates the
   *  remembered values. Dedup is on the canonical mm value; `units` controls the
   *  mm->export-unit conversion applied at formatting (ADR-0022). */
  coordWords(
    x: number,
    y: number,
    z: number,
    decimals: number,
    units: PostUnits,
  ): string[]
  /** Return the motion-mode word (e.g. 'G0'/'G1') only if it changed. */
  motionWord(mode: string): string | null
  /** Return the F word only if the feed changed. Feed is mm/min canonical;
   *  `units` converts it to IPM (/25.4) at formatting. */
  feedWord(feed: number, decimals: number, units: PostUnits): string | null
  /** Return the S word only if the speed changed. */
  speedWord(rpm: number): string | null
  /** Forget all remembered state so the next emission re-emits everything. */
  forceReset(): void
}

export function createModalState(): ModalState {
  let lastMotion: string | null = null
  let lastX: number | null = null
  let lastY: number | null = null
  let lastZ: number | null = null
  let lastF: number | null = null
  let lastS: number | null = null

  return {
    coordWords(x, y, z, decimals, units) {
      const words: string[] = []
      if (lastX === null || x !== lastX) {
        words.push(dimWord('X', x, decimals, units))
        lastX = x
      }
      if (lastY === null || y !== lastY) {
        words.push(dimWord('Y', y, decimals, units))
        lastY = y
      }
      if (lastZ === null || z !== lastZ) {
        words.push(dimWord('Z', z, decimals, units))
        lastZ = z
      }
      return words
    },
    motionWord(mode) {
      if (mode === lastMotion) return null
      lastMotion = mode
      return mode
    },
    feedWord(feed, decimals, units) {
      if (lastF !== null && feed === lastF) return null
      lastF = feed
      // Feed is mm/min canonical -> IPM via the same /25.4 scale at the seam.
      return word('F', feed / (units === 'inch' ? 25.4 : 1), decimals)
    },
    speedWord(rpm) {
      if (lastS !== null && rpm === lastS) return null
      lastS = rpm
      return sWord(rpm)
    },
    forceReset() {
      lastMotion = null
      lastX = null
      lastY = null
      lastZ = null
      lastF = null
      lastS = null
    },
  }
}
