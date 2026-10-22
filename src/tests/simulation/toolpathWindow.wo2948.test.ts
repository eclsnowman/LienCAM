import { describe, expect, it } from 'vitest'
import { selectToolpathWindow, type WindowFrame } from '../../lib/simulation/toolpathWindow'
import { buildFrames } from '../../components/simulation/SimulationPanel'
import type { ToolpathMove } from '../../types'

function frames(count = 10): WindowFrame[] {
  return Array.from({ length: count }, (_, i) => ({
    fromX: i * 10, fromY: 0, fromZ: 0, toX: (i + 1) * 10, toY: 0, toZ: 0,
    startMs: i * 1000, durationMs: 1000, role: i % 2 ? 'rapid' : 'cut',
  }))
}

describe('WO-2948 bounded cursor window', () => {
  it('clips recent/upcoming at the same marker fraction and preserves frame identity/roles', () => {
    const path = frames()
    const before = structuredClone(path)
    const result = selectToolpathWindow(path, 4, 4500)
    const recent = result.find(s => s.frameIndex === 4 && s.phase === 'recent')!
    const upcoming = result.find(s => s.frameIndex === 4 && s.phase === 'upcoming')!
    expect([recent.toX, upcoming.fromX]).toEqual([45, 45])
    expect(recent.frame).toBe(path[4])
    expect(result.find(s => s.frameIndex === 3)?.frame.role).toBe('rapid')
    expect(Math.min(...result.map(s => s.fromX))).toBe(25)
    expect(Math.max(...result.map(s => s.toX))).toBe(65)
    expect(path).toEqual(before)
  })

  it('supports rewind, seek, pause, start/end and empty paths without stale state', () => {
    const path = frames()
    expect(selectToolpathWindow(path, 0, 0).every(s => s.phase === 'upcoming')).toBe(true)
    expect(selectToolpathWindow(path, 9, 10000).every(s => s.phase === 'recent')).toBe(true)
    const paused = selectToolpathWindow(path, 3, 3200)
    selectToolpathWindow(path, 8, 8900)
    expect(selectToolpathWindow(path, 3, 3200)).toEqual(paused)
    expect(selectToolpathWindow([], 0, 0)).toEqual([])
  })

  it('reads at most a bounded neighborhood even with a million zero-duration frames', () => {
    const path = frames(1)
    path[0].durationMs = 0
    let reads = 0
    const large = new Proxy({ length: 1000000 } as WindowFrame[], {
      get(target, key) {
        if (key === 'length') return target.length
        reads++
        return path[0]
      },
    })
    expect(selectToolpathWindow(large, 500000, 0)).toHaveLength(64)
    expect(reads).toBeLessThanOrEqual(128)
  })

  it('retains original arc move references/indices through production frame sampling', () => {
    const moves: ToolpathMove[] = [
      { type: 'feed', x: 10, y: 0, z: 0, feed: 600, role: 'cut' },
      { type: 'arc_ccw', x: 0, y: 10, z: 0, cx: 0, cy: 0, feed: 600, role: 'cut' },
      { type: 'rapid', x: 0, y: 10, z: 5, role: 'rapid' },
    ]
    const before = structuredClone(moves)
    const { frames: sampled } = buildFrames(moves, 5000)
    const result = selectToolpathWindow(sampled, 2, sampled[2].startMs)
    expect(result.length).toBeGreaterThan(0)
    expect(sampled.filter(f => f.role === 'cut').every(f => f.sourceMove === moves[1] && f.sourceMoveIndex === 1)).toBe(true)
    expect(sampled.at(-1)?.sourceMove).toBe(moves[2])
    expect(moves).toEqual(before)
  })
})
