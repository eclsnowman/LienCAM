// WO-1629 - the path check must not overflow on a long program.
//
// On Operator's ~110,000-move file the Path check reported "CANNOT ASSESS ...
// Maximum call stack size exceeded". `pathFidelity.ts` computed the run's
// fastest commanded feed with `Math.max(...feeds)`, spreading one stack
// argument per move - that blows the call stack long before 110,000. This
// test synthesises a program well past the size that reproduced the defect
// (250,000 moves) and proves the production entry point, `analysePathFidelity`,
// scores it instead of throwing.

import { describe, expect, it } from 'vitest'
import { analysePathFidelity } from '../../lib/machine/pathFidelity'
import type { QueuedMove } from '../../lib/machine/controller'
import type { MachineVec3 } from '../../lib/machine/controller'

const MOVE_COUNT = 250_000

/** A straight line along X, one move per millimetre - `to.x` of move `id` is
 *  `id`, so the start of move `id` is `id - 1` and a sample can be placed
 *  exactly on the commanded path without resolving spans by hand. */
function longProgram(): QueuedMove[] {
  const moves: QueuedMove[] = new Array(MOVE_COUNT)
  for (let i = 0; i < MOVE_COUNT; i++) {
    moves[i] = { id: i + 1, kind: 'line', to: { x: i + 1, y: 0, z: 0 }, feedMmMin: 1000 }
  }
  return moves
}

function sampleAt(moveId: number, atMs: number): {
  atMs: number
  machinePos: MachineVec3
  executingMoveId: number
} {
  return { atMs, machinePos: { x: moveId - 1, y: 0, z: 0 }, executingMoveId: moveId }
}

describe('WO-1629 long program', () => {
  it('assesses a 250,000-move program instead of overflowing the stack', () => {
    const moves = longProgram()
    const report = analysePathFidelity({
      moves,
      startPos: { x: 0, y: 0, z: 0 },
      samples: [
        sampleAt(10, 0),
        sampleAt(60_000, 100),
        sampleAt(120_000, 200),
        sampleAt(180_000, 300),
        sampleAt(240_000, 400),
      ],
      reportsExecutingMoveId: true,
      toleranceMm: 0.03,
    })

    expect(report.headline).not.toContain('Maximum call stack')
    expect(report.headline).not.toContain('CANNOT ASSESS')
    expect(report.verdict).not.toBe('unknown')
    expect(report.verdict).toBe('clean')
  })
})
