import { describe, expect, it } from 'vitest'
import { control, move } from './alpha3CollectorControls'
import { shortSegmentShare } from './metrics.alpha3'

describe('WO-2902 air feed', () => {
  it('counts the repeated cleared cut as air, while the first cut removes material', () => {
    const start = move(2, 5, -1, { type: 'rapid', role: 'rapid' })
    const first = control([start, move(38, 5, -1)])
    const repeated = control([start, move(38, 5, -1), move(2, 5, -1)])
    expect(first.metrics['M-AIR-1']).toBe(0)
    expect(repeated.metrics['M-AIR-1']).toBe(36)
    expect(repeated.metrics['M-AIR-1.share']).toBe(50)
    expect(repeated.metrics['M-AIR-2']).toBe(3.6)
    expect(repeated.metrics['M-TIME-3']).toBe(first.metrics['M-TIME-3'])
    expect(first.metrics['M-TIME-3']).toBeGreaterThan(60)
  })
  it('does not count rapids as feed air and records unknown time honestly', () => {
    const r = control([move(2, 5, 2, { type: 'rapid', role: 'rapid' }), move(38, 5, 2, { type: 'rapid', role: 'rapid' })])
    expect(r.metrics['M-AIR-1']).toBe(0)
    const fed = control([move(2, 5, 2), move(38, 5, 2, { feed: undefined })])
    expect(fed.metrics['M-AIR-1']).toBe(36)
    expect(fed.metrics['M-AIR-2']).toMatchObject({ value: null })
  })
  it('parameterises short-segment demand without inventing a controller period', () => {
    const moves = [move(0, 0, 0), move(0.1, 0, 0, { feed: 600 }), move(10, 0, 0, { feed: 600 })]
    expect(shortSegmentShare(moves)).toMatchObject({ value: null })
    expect(shortSegmentShare(moves, 20)).toBe(1)
  })
})
