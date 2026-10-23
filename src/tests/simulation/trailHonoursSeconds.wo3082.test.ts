// WO-3082: the Simulation cutter trail shows the seconds the operator typed.
// A 32-segment cap filled after 2-3 s on finely sampled paths (helix, arcs), so
// Trail/Lead values above that changed nothing on screen (owner release review).
import { describe, expect, it } from 'vitest'
import { selectToolpathWindow, type WindowFrame } from '../../lib/simulation/toolpathWindow'

// 20 frames per second: what a sampled helix or arc looks like to the selector.
function dense(seconds: number): WindowFrame[] {
  return Array.from({ length: seconds * 20 }, (_, i) => ({
    fromX: i, fromY: 0, fromZ: 0, toX: i + 1, toY: 0, toZ: 0,
    startMs: i * 50, durationMs: 50, role: 'ramp',
  }))
}

const reach = (segments: ReturnType<typeof selectToolpathWindow>, phase: 'recent' | 'upcoming') => {
  const side = segments.filter(segment => segment.phase === phase)
  return phase === 'upcoming'
    ? Math.max(...side.map(segment => segment.toX))
    : Math.min(...side.map(segment => segment.fromX))
}

describe('WO-3082 cutter trail honours the typed seconds on dense paths', () => {
  it('a 10 s lead reaches 10 s ahead, not the first 32 samples', () => {
    const path = dense(120)
    const two = selectToolpathWindow(path, 1200, 60_000, { recentMs: 2000, upcomingMs: 2000 })
    const ten = selectToolpathWindow(path, 1200, 60_000, { recentMs: 2000, upcomingMs: 10_000 })
    expect(reach(two, 'upcoming')).toBe(1240)
    expect(reach(ten, 'upcoming')).toBe(1400)
  })

  it('a 30 s trail reaches 30 s back', () => {
    const path = dense(120)
    const result = selectToolpathWindow(path, 1200, 60_000, { recentMs: 30_000, upcomingMs: 0 })
    expect(reach(result, 'recent')).toBe(600)
  })

  it('the 60 s maximum on each side is drawn in full', () => {
    const path = dense(180)
    const result = selectToolpathWindow(path, 1800, 90_000, { recentMs: 60_000, upcomingMs: 60_000 })
    expect(reach(result, 'recent')).toBe(600)
    expect(reach(result, 'upcoming')).toBe(3000)
  })
})
