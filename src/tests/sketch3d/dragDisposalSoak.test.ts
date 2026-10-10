// HEAP DISCIPLINE SOAK (criterion 6) - the drag-session companion to SKC-1's
// disposalSoak.test.ts. Same pattern: a fresh service per cycle, disposed in a finally block,
// so the fixed 16 MB wasm heap never has to hold more than one service's state at a time.
// Exercises the FULL interactive loop (begin -> move x20 -> end) rather than a bare solve(),
// on the WO-specified 100-entity fixture, for the WO-specified 500 cycles - do not shrink
// either number without re-deriving the criterion.
import { describe, expect, it } from 'vitest'
import { Sketch3dDragSession, createSketch3dSolveService } from '../../sketch3d'
import { chainDragFixture } from './dragFixtures'

const ENTITY_COUNT = 100
const CYCLES = 500
const MOVES_PER_CYCLE = 20

describe('sketch3d drag session heap discipline soak', () => {
  it(`survives ${CYCLES} begin/move x${MOVES_PER_CYCLE}/end cycles on a ${ENTITY_COUNT}-entity sketch without heap exhaustion`, async () => {
    const { document, dragPoint } = chainDragFixture(ENTITY_COUNT)
    let referenceDof = -1

    for (let cycle = 0; cycle < CYCLES; cycle++) {
      const service = await createSketch3dSolveService()
      try {
        const session = new Sketch3dDragSession(service, document)
        const begun = session.begin(dragPoint, { x: cycle % 20, y: (cycle % 13) * 0.5 })
        expect(begun.status, `cycle ${cycle} begin: ${begun.error ?? ''}`).toBe('success')

        let last = begun
        for (let m = 0; m < MOVES_PER_CYCLE; m++) {
          last = session.move({ x: (m % 20) - 10, y: ((m * 3) % 20) - 10 })
          expect(last.status, `cycle ${cycle} move ${m}: ${last.error ?? ''}`).toBe('success')
        }

        const ended = session.end()
        expect(ended.status, `cycle ${cycle} end: ${ended.error ?? ''}`).toBe('success')
        if (referenceDof === -1) referenceDof = ended.dof
        else expect(ended.dof, `cycle ${cycle} dof drifted`).toBe(referenceDof)
      } finally {
        service.dispose()
      }
    }
  }, 300000)
})
