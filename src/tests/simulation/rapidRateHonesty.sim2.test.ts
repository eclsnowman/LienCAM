import { describe, expect, it } from 'vitest'
import {
  buildFrames,
  RAPID_SPEED,
} from '../../components/simulation/SimulationPanel'

const rapidMoves = [
  { x: 0, y: 0, z: 0, type: 'rapid' },
  { x: 60, y: 0, z: 0, type: 'rapid' },
]

const cuttingMoves = [
  { x: 0, y: 0, z: 0, type: 'cut', feed: 750 },
  { x: 60, y: 0, z: 0, type: 'cut', feed: 750 },
]

const durationFor = (
  moves: { x: number; y: number; z: number; type: string; feed?: number }[],
  rapidRate: number,
) => buildFrames(moves, rapidRate).frames[0].durationMs

describe('SIM-2 machine rapid-rate playback timing', () => {
  it('uses inverse proportional timing when the machine rapid rate doubles', () => {
    const r1 = 3000
    const r2 = 2 * r1

    const r1Duration = durationFor(rapidMoves, r1)
    const r2Duration = durationFor(rapidMoves, r2)

    expect(r1Duration).toBe(2 * r2Duration)
  })

  it('leaves explicit cutting feed timing unchanged across rapid rates', () => {
    const r1Duration = durationFor(cuttingMoves, 3000)
    const r2Duration = durationFor(cuttingMoves, 6000)

    expect(r1Duration).toBe(r2Duration)
  })

  it('falls back to RAPID_SPEED for every non-finite or non-positive rate', () => {
    const fallbackDuration = durationFor(rapidMoves, RAPID_SPEED)

    for (const invalidRate of [Number.NaN, Number.POSITIVE_INFINITY, 0, -100]) {
      const durationMs = durationFor(rapidMoves, invalidRate)

      expect(durationMs).toBe(fallbackDuration)
      expect(Number.isFinite(durationMs)).toBe(true)
      expect(durationMs).toBeGreaterThan(0)
    }
  })
})
