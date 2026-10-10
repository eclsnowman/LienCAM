import { describe, expect, it } from 'vitest'
import {
  buildFrames,
  formatMoveReadout,
} from '../../components/simulation/SimulationPanel'

const moves = [
  { x: 0, y: 0, z: 0, type: 'rapid' },
  { x: 100, y: 0, z: 0, type: 'rapid', role: 'rapid' },
  { x: 120, y: 0, z: 0, type: 'feed', feed: 800, role: 'cut' },
]

function speedImpliedByTiming(frame: ReturnType<typeof buildFrames>['frames'][number]): number {
  const dx = frame.toX - frame.fromX
  const dy = frame.toY - frame.fromY
  const dz = frame.toZ - frame.fromZ
  const distanceMm = Math.sqrt(dx * dx + dy * dy + dz * dz)
  return distanceMm / frame.durationMs * 60_000
}

describe('SIM-3 live move readout', () => {
  it('uses each frame commanded speed for both timing and readout text', () => {
    const frames = buildFrames(moves, 5000).frames

    expect(frames).toHaveLength(2)
    expect(frames.map(frame => frame.speedMmPerMin)).toEqual([5000, 800])
    expect(frames.map(speedImpliedByTiming)).toEqual([5000, 800])
    expect(frames.map(frame => formatMoveReadout(frame, 'mm'))).toEqual([
      'RAPID @ 5000.0 mm/min',
      'CUT @ 800.0 mm/min',
    ])
  })

  it('changes with the current frame, converts units, and dashes an empty path', () => {
    const frames = buildFrames(moves, 5000).frames

    expect(frames.map(frame => formatMoveReadout(frame, 'inch'))).toEqual([
      'RAPID @ 196.9 in/min',
      'CUT @ 31.5 in/min',
    ])
    expect(formatMoveReadout(null, 'mm')).toBe('—')
  })
})
