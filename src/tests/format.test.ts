import { describe, it, expect } from 'vitest'
import { formatElapsedSeconds, formatComputeMs, formatDurationHMS } from '../lib/format'

// Pure display formatters (src/lib/format.ts). formatElapsedSeconds drives the
// NestModal live "Packing... Ns" timer; the siblings format compute / cut time.

describe('formatElapsedSeconds', () => {
  it('floors to whole seconds so the count never runs ahead of real time', () => {
    expect(formatElapsedSeconds(0)).toBe('0s')
    expect(formatElapsedSeconds(950)).toBe('0s')
    expect(formatElapsedSeconds(1000)).toBe('1s')
    expect(formatElapsedSeconds(12999)).toBe('12s')
    expect(formatElapsedSeconds(30000)).toBe('30s')
  })

  it('treats non-positive / non-finite input as 0s', () => {
    expect(formatElapsedSeconds(-5)).toBe('0s')
    expect(formatElapsedSeconds(NaN)).toBe('0s')
    expect(formatElapsedSeconds(Infinity)).toBe('0s')
  })
})

describe('formatComputeMs', () => {
  it('renders sub-second as "N ms" and >= 1s as "N.N s"', () => {
    expect(formatComputeMs(123)).toBe('123 ms')
    expect(formatComputeMs(999)).toBe('999 ms')
    expect(formatComputeMs(1000)).toBe('1.0 s')
    expect(formatComputeMs(4200)).toBe('4.2 s')
  })

  it('returns "-" for non-finite / negative input', () => {
    expect(formatComputeMs(-1)).toBe('-')
    expect(formatComputeMs(NaN)).toBe('-')
  })
})

describe('formatDurationHMS', () => {
  it('formats seconds, minutes, and hours', () => {
    expect(formatDurationHMS(0)).toBe('0s')
    expect(formatDurationHMS(45000)).toBe('45s')
    expect(formatDurationHMS(154000)).toBe('2m 34s')
    expect(formatDurationHMS(3780000)).toBe('1h 03m')
  })
})
