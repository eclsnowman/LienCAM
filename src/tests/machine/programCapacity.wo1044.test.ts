import { describe, expect, it } from 'vitest'
import type { MachineProgram, QueuedMove } from '../../lib/machine/controller'
import { assessProgramCapacity } from '../../lib/program/programCapacity'

function program(count: number, rapidEvery = 4_000): MachineProgram {
  const steps: QueuedMove[] = Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    kind: 'line',
    to: { x: 0, y: 0, z: 0 },
    feedMmMin: 1_000,
    ...((index + 1) % rapidEvery === 0 ? { rapid: true as const } : {}),
  }))
  return {
    frame: 'work',
    units: 'mm',
    steps,
    index: Object.fromEntries(steps.map((step) => [step.id, { opId: 'op', setupId: 'setup', moveOrdinal: step.id - 1 }])),
  }
}

describe('WO-1044 capacity plan retained for WO-1054 execution', () => {
  it('keeps the wrap edge at 4095 and plans 4096 only at a rapid', () => {
    expect(assessProgramCapacity(program(4_095).steps, 4_095)).toMatchObject({
      count: 4_095,
      fits: true,
      parts: [{ start: 0, end: 4_095, count: 4_095 }],
    })
    expect(assessProgramCapacity(program(4_096).steps, 4_095)).toMatchObject({
      count: 4_096,
      fits: false,
      parts: [
        { start: 0, end: 4_000, count: 4_000 },
        { start: 4_000, end: 4_096, count: 96 },
      ],
    })
  })

  it('refuses an over-cap feed-only stretch instead of cutting it apart', () => {
    const result = assessProgramCapacity(program(4_096, 10_000).steps, 4_095)
    expect(result.parts).toBeNull()
    expect(result.splitRefusal).toBe(
      'one continuous cutting stretch of 4,096 moves has no rapid to split at; the board holds 4,095.',
    )
  })
})
