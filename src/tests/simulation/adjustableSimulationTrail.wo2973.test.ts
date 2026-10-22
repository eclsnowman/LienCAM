import { describe, expect, it } from 'vitest'
import {
  selectToolpathWindow,
  TOOLPATH_WINDOW_MAX_MS,
  TOOLPATH_WINDOW_SIDE_LIMIT,
  type WindowFrame,
} from '../../lib/simulation/toolpathWindow'

function frames(count = 10): WindowFrame[] {
  return Array.from({ length: count }, (_, i) => ({
    fromX: i * 10, fromY: 0, fromZ: 0, toX: (i + 1) * 10, toY: 0, toZ: 0,
    startMs: i * 1000, durationMs: 1000, role: 'cut',
  }))
}

describe('WO-2973 adjustable simulation trail selector', () => {
  it('selects independent asymmetric recent trail and upcoming lead durations', () => {
    const result = selectToolpathWindow(frames(), 4, 4500, { recentMs: 500, upcomingMs: 3000 })
    const recent = result.filter(segment => segment.phase === 'recent')
    const upcoming = result.filter(segment => segment.phase === 'upcoming')
    expect(Math.min(...recent.map(segment => segment.fromX))).toBe(40)
    expect(Math.max(...recent.map(segment => segment.toX))).toBe(45)
    expect(Math.min(...upcoming.map(segment => segment.fromX))).toBe(45)
    expect(Math.max(...upcoming.map(segment => segment.toX))).toBe(75)
  })

  it('makes zero a deliberate empty side at start, end, seek, rewind, and pause', () => {
    const path = frames()
    const onlyUpcoming = selectToolpathWindow(path, 4, 4500, { recentMs: 0, upcomingMs: 1000 })
    const onlyRecent = selectToolpathWindow(path, 4, 4500, { recentMs: 1000, upcomingMs: 0 })
    expect(onlyUpcoming).not.toHaveLength(0)
    expect(onlyUpcoming.every(s => s.phase === 'upcoming')).toBe(true)
    expect(onlyRecent).not.toHaveLength(0)
    expect(onlyRecent.every(s => s.phase === 'recent')).toBe(true)
    expect(selectToolpathWindow(path, 0, 0, { recentMs: 0, upcomingMs: 0 })).toEqual([])
    const end = selectToolpathWindow(path, 9, 10000, { recentMs: 1000, upcomingMs: 0 })
    expect(end).not.toHaveLength(0)
    expect(end.every(s => s.phase === 'recent')).toBe(true)
    const paused = selectToolpathWindow(path, 3, 3200, { recentMs: 750, upcomingMs: 1250 })
    selectToolpathWindow(path, 8, 8900, { recentMs: 750, upcomingMs: 1250 })
    expect(selectToolpathWindow(path, 3, 3200, { recentMs: 750, upcomingMs: 1250 })).toEqual(paused)
  })

  it('keeps bounded indexed work for long requested durations and a rebuilt path', () => {
    const one = frames(1)
    let reads = 0
    const large = new Proxy({ length: 1_000_000 } as WindowFrame[], {
      get(target, key) {
        if (key === 'length') return target.length
        reads++
        return one[0]
      },
    })
    expect(selectToolpathWindow(large, 500_000, 500, { recentMs: TOOLPATH_WINDOW_MAX_MS, upcomingMs: TOOLPATH_WINDOW_MAX_MS }))
      .toHaveLength(TOOLPATH_WINDOW_SIDE_LIMIT * 2)
    expect(reads).toBeLessThanOrEqual(TOOLPATH_WINDOW_SIDE_LIMIT * 4)
    const rebuilt = frames(2).map(frame => ({ ...frame, fromX: frame.fromX + 100, toX: frame.toX + 100 }))
    expect(selectToolpathWindow(rebuilt, 0, 0, { recentMs: 1000, upcomingMs: 1000 })[0].fromX).toBe(100)
  })
})
